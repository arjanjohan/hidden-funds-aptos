// Pipeline state: candidates, stored positions, cursors and memo. Derived from chain data only, so a lost
// state file costs one full rebuild run, not data.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Memo, Position, SourceDef } from '../shared/types.ts';

const DAY_MS = 86_400_000;
/** Longest time a known position goes without a re-read. Monthly owners are normally re-read every 28 days (see
 *  `spread`); 35 days is the hard limit while they settle into their week. */
export const AGE_LIMIT_MS = { every_run: 0, weekly: 7 * DAY_MS, monthly: 35 * DAY_MS, never: Infinity } as const;

/** Monthly re-reads are spread over 4 weekly runs: from day 21, an owner is due in the week matching a bucket taken
 *  from its address, so each run carries about a quarter of them instead of all at once. */
const SPREAD_FROM_MS = 21 * DAY_MS;
const spreadDue = (owner: string, nowMs: number) => parseInt(owner.slice(-4), 16) % 4 === Math.floor(nowMs / (7 * DAY_MS)) % 4;

export class State {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      create table if not exists candidates (source text, owner text, hint text, first_seen text, last_read_at text,
        last_nonzero integer, last_complete integer, changed_at text, primary key (source, owner));
      create table if not exists positions (id text primary key, source text, owner text, json text, read_at text);
      create index if not exists positions_source_owner on positions (source, owner);
      create table if not exists cursors (source text primary key, value text);
      create table if not exists memo (key text primary key, value text);
    `);
    // State files written before these columns existed (the cache is long-lived).
    const columns = (this.db.prepare('pragma table_info(candidates)').all() as any[]).map(c => c.name);
    if (!columns.includes('changed_at')) this.db.exec('alter table candidates add column changed_at text');
    if (!columns.includes('dirty')) {
      this.db.exec('alter table candidates add column dirty integer not null default 0');
      this.db.exec('update candidates set dirty = 1 where last_read_at is null or changed_at > last_read_at');
    }
  }

  cursor(source: string): string | undefined {
    return (this.db.prepare('select value from cursors where source = ?').get(source) as any)?.value;
  }

  setCursor(source: string, value: string) {
    this.db.prepare('insert into cursors values (?, ?) on conflict(source) do update set value = excluded.value').run(source, value);
  }

  /** Insert new candidates and record which ones changed: new, re-enumerated by an incremental (activity) scan, or
   *  with a different hint. A changed candidate is due regardless of its refresh window. Never deletes candidates.
   *  An incremental scan's hint is a delta: it is deep-merged into the stored hint. A hint's `w` (the version the
   *  enumeration's scans reached, which advances every run) is stored but is not a change, except for an owner with a
   *  position whose age was unknown: readers leave an age unknown when the holding changed after the scans, so a later
   *  watermark may date it. */
  upsertCandidates(source: string, candidates: { owner: string; hint?: unknown }[], now: string, incremental = false) {
    const stmt = this.db.prepare(`insert into candidates (source, owner, hint, first_seen, changed_at, dirty) values (?, ?, ?, ?, ?, 1)
      on conflict(source, owner) do update set
        dirty = case when ? then 1 else candidates.dirty end,
        changed_at = case when ? then excluded.changed_at else candidates.changed_at end,
        hint = excluded.hint`);
    const stored = this.db.prepare('select hint from candidates where source = ? and owner = ?');
    const undated = this.db.prepare(`select 1 from positions where source = ? and owner = ? and json_extract(json, '$.ageBasis') = 'unknown' limit 1`);
    this.db.exec('begin');
    for (const c of candidates) {
      const prev = (stored.get(source, c.owner) as { hint: string | null } | undefined)?.hint ?? null;
      const hint = incremental && c.hint !== undefined && prev ? deepMerge(JSON.parse(prev), c.hint) : c.hint;
      const text = hint === undefined ? null : JSON.stringify(hint);
      const changed = incremental || withoutWatermark(prev) !== withoutWatermark(text) || (prev !== text && !!undated.get(source, c.owner));
      stmt.run(source, c.owner, text, now, now, changed ? 1 : 0, changed ? 1 : 0);
    }
    this.db.exec('commit');
  }

  /** Candidates due for a read. Known non-zero and incomplete owners follow refresh.nonZero, zero owners refresh.zero. */
  due(source: SourceDef<any>, nowMs: number, enumerated: Set<string>, storedHints = false): { owner: string; hint?: unknown; priority: number }[] {
    const rows = this.db.prepare('select owner, hint, last_read_at, last_nonzero, last_complete, dirty from candidates where source = ?').all(source.id) as any[];
    const out: { owner: string; hint?: unknown; priority: number }[] = [];
    for (const r of rows) {
      // Dirty: new, changed since its last read, or its source's rules changed. A read clears it.
      const age = r.dirty || !r.last_read_at ? Infinity : nowMs - Date.parse(r.last_read_at);
      const limit = r.last_nonzero || r.last_complete === 0 ? AGE_LIMIT_MS[source.refresh.nonZero] : AGE_LIMIT_MS[source.refresh.zero];
      // Reads slightly early so a weekly cadence never skips a run because of schedule jitter.
      const spread = limit === AGE_LIMIT_MS.monthly && age >= SPREAD_FROM_MS && spreadDue(r.owner, nowMs);
      if (age < limit - DAY_MS / 2 && !spread) continue;
      // A full scan refreshes every hint, so only this run's hints apply; an incremental scan only returns changed
      // owners, so for the rest the stored hint is the latest knowledge.
      const hint = r.hint && (storedHints || enumerated.has(r.owner)) ? JSON.parse(r.hint) : undefined;
      out.push({ owner: r.owner, hint, priority: r.last_read_at ? (r.last_nonzero ? 1 : 2) : 0 });
    }
    return out.sort((a, b) => a.priority - b.priority);
  }

  /** Replace an owner's positions after a complete read; after an incomplete read the previous positions stay. */
  recordRead(source: string, owner: string, positions: Position[], complete: boolean, now: string) {
    this.db.exec('begin');
    if (complete) {
      this.db.prepare('delete from positions where source = ? and owner = ?').run(source, owner);
      const stmt = this.db.prepare('insert into positions values (?, ?, ?, ?, ?)');
      for (const p of positions) stmt.run(p.id, source, owner, JSON.stringify(p), now);
    }
    const nonzero = complete ? (positions.length > 0 ? 1 : 0) : (this.positionsOf(source, owner).length > 0 ? 1 : 0);
    // An incomplete read stays dirty, so it is retried next run whatever the source's refresh window.
    this.db.prepare('update candidates set last_read_at = ?, last_nonzero = ?, last_complete = ?, dirty = ? where source = ? and owner = ?')
      .run(now, nonzero, complete ? 1 : 0, complete ? 0 : 1, source, owner);
    this.db.exec('commit');
  }

  positionsOf(source: string, owner?: string): Position[] {
    const rows = (owner
      ? this.db.prepare('select json from positions where source = ? and owner = ?').all(source, owner)
      : this.db.prepare('select json from positions where source = ?').all(source)) as any[];
    return rows.map(r => JSON.parse(r.json));
  }

  /** Mark every candidate of a source changed, so all are due on this run (used when a source's rules change). */
  markAllChanged(source: string, now: string) {
    this.db.prepare('update candidates set changed_at = ?, dirty = 1 where source = ?').run(now, source);
  }

  /** Owners of a source with stored positions that are due for a re-read (changed, or last read incompletely). */
  pendingNonzero(source: string): number {
    return (this.db.prepare('select count(*) as n from candidates where source = ? and last_nonzero = 1 and dirty = 1').get(source) as { n: number }).n;
  }

  /** Mark every candidate of a source with stored positions changed (used when a rule that applies to positions, not
   *  to finding them, changes: owners without positions have nothing stale). */
  markNonzeroChanged(source: string, now: string) {
    this.db.prepare('update candidates set changed_at = ?, dirty = 1 where source = ? and last_nonzero = 1').run(now, source);
  }

  /** After a full scan: an owner with positions that the scan no longer returns has changed (it exited, claimed or
   *  moved its holding), so it is due now rather than at its next monthly re-read. */
  markGone(source: string, enumerated: Set<string>, now: string) {
    const rows = this.db.prepare('select owner from candidates where source = ? and last_nonzero = 1').all(source) as { owner: string }[];
    const mark = this.db.prepare('update candidates set changed_at = ?, dirty = 1 where source = ? and owner = ?');
    this.db.exec('begin');
    for (const r of rows) if (!enumerated.has(r.owner)) mark.run(now, source, r.owner);
    this.db.exec('commit');
  }

  /** Positions last read before `cutoff`: older than the source's own refresh window for non-zero owners. */
  staleCount(source: string, cutoff: string): number {
    return (this.db.prepare('select count(*) n from positions where source = ? and read_at < ?').get(source, cutoff) as any).n;
  }

  candidateCount(source: string): number {
    return (this.db.prepare('select count(*) n from candidates where source = ?').get(source) as any).n;
  }

  memo(): Memo {
    const get = this.db.prepare('select value from memo where key = ?');
    const set = this.db.prepare('insert into memo values (?, ?) on conflict(key) do update set value = excluded.value');
    return {
      get: async key => (get.get(key) as any)?.value,
      set: async (key, value) => { set.run(key, value); },
    };
  }

  close() { this.db.close(); }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A stored hint without its scan watermark `w`, for change detection. */
function withoutWatermark(text: string | null): string | null {
  if (text === null) return null;
  const hint = JSON.parse(text);
  if (!isRecord(hint) || !('w' in hint)) return text;
  const { w: _w, ...rest } = hint;
  return JSON.stringify(rest);
}

function deepMerge(a: unknown, b: unknown): unknown {
  if (!isRecord(a) || !isRecord(b)) return b;
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = deepMerge(a[k], v);
  return out;
}
