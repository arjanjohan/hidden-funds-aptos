// Pipeline state: candidates, stored positions, cursors and memo. Derived from chain data only, so a lost
// state file costs one full rebuild run, not data.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Memo, Position, SourceDef } from '../shared/types.ts';

const DAY_MS = 86_400_000;
export const AGE_LIMIT_MS = { every_run: 0, weekly: 7 * DAY_MS, monthly: 30 * DAY_MS } as const;

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
   *  with a different hint. A changed candidate is due regardless of its refresh window. Never deletes candidates. */
  upsertCandidates(source: string, candidates: { owner: string; hint?: unknown }[], now: string, incremental = false) {
    const stmt = this.db.prepare(`insert into candidates (source, owner, hint, first_seen, changed_at, dirty) values (?, ?, ?, ?, ?, 1)
      on conflict(source, owner) do update set
        dirty = case when ? or candidates.hint is not excluded.hint then 1 else candidates.dirty end,
        changed_at = case when ? or candidates.hint is not excluded.hint then excluded.changed_at else candidates.changed_at end,
        hint = excluded.hint`);
    this.db.exec('begin');
    for (const c of candidates) stmt.run(source, c.owner, c.hint === undefined ? null : JSON.stringify(c.hint), now, now, incremental ? 1 : 0, incremental ? 1 : 0);
    this.db.exec('commit');
  }

  /** Candidates due for a read. Known non-zero and incomplete owners follow refresh.nonZero, zero owners refresh.zero. */
  due(source: SourceDef<any>, nowMs: number, enumerated: Set<string>): { owner: string; hint?: unknown; priority: number }[] {
    const rows = this.db.prepare('select owner, hint, last_read_at, last_nonzero, last_complete, dirty from candidates where source = ?').all(source.id) as any[];
    const out: { owner: string; hint?: unknown; priority: number }[] = [];
    for (const r of rows) {
      // Dirty: new, changed since its last read, or its source's rules changed. A read clears it.
      const age = r.dirty || !r.last_read_at ? Infinity : nowMs - Date.parse(r.last_read_at);
      const limit = r.last_nonzero || r.last_complete === 0 ? AGE_LIMIT_MS[source.refresh.nonZero] : AGE_LIMIT_MS[source.refresh.zero];
      // Reads slightly early so a weekly cadence never skips a run because of schedule jitter.
      if (age < limit - DAY_MS / 2) continue;
      // A hint only applies when this run's enumeration produced it; otherwise the source discovers for itself.
      const hint = enumerated.has(r.owner) && r.hint ? JSON.parse(r.hint) : undefined;
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
