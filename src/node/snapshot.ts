// Weekly snapshot: enumerate → revalidate → price → aggregate. Publishes aggregates only, never addresses.
//
// Usage: node src/node/snapshot.ts [--source id] [--limit N] [--cap N] [--state path] [--out path]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ageDays, applyOwnerKind, HEADLINE_AGE_DAYS, headlineAge, sourceTotals, usd, type PriceBook } from '../shared/accounting.ts';
import { ownerKind } from '../shared/owners.ts';
import { mapLimit } from '../shared/chain.ts';
import { SOURCES } from '../shared/sources/index.ts';
import type { ChainReader, Ledger, Position, ReadContext, SourceDef } from '../shared/types.ts';
import { keyedReader, processorWatermark, RequestCapReached } from './client.ts';
import { ENUMERATORS, type Enumerator } from './enumerators.ts';
import type { Snapshot, SnapshotSource, SourceRun } from '../shared/snapshot.ts';
import { fetchPrices } from './prices.ts';
import { AGE_LIMIT_MS, State } from './state.ts';

const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const ONLY = opt('--source');
const LIMIT = opt('--limit') ? Number(opt('--limit')) : Infinity;
const CAP = Number(opt('--cap') ?? process.env.REQUEST_CAP ?? 100_000);
const STATE = opt('--state') ?? 'state/state.sqlite';
const OUT = opt('--out') ?? 'snapshot/latest.json';
const CONCURRENCY = 8;
const WATERMARK_MAX_LAG_MS = 60 * 60_000;

const SIZE_BANDS = [1, 10, 100, 1_000, 10_000];

export function sizeBands(positions: Position[], prices: PriceBook) {
  const counts = new Array(SIZE_BANDS.length + 1).fill(0);
  for (const p of positions) {
    if (p.status !== 'recoverable') continue;
    const v = usd(p.expectedPayout, prices);
    if (v === null) continue;
    const i = SIZE_BANDS.findIndex(b => v < b);
    counts[i === -1 ? SIZE_BANDS.length : i]++;
  }
  return counts.map((positions, i) => ({ upTo: SIZE_BANDS[i] ?? null, positions }));
}

export async function runSource(def: SourceDef<any>, en: Enumerator, state: State, chain: ChainReader, capHit: { hit: boolean }): Promise<{ run: SourceRun; ledger?: Ledger }> {
  const run: SourceRun = { processor: en.processor, scope: en.scope, enumeration: { pages: 0, newCandidates: 0, candidates: 0 },
    verification: { read: 0, incomplete: 0, notReread: 0 }, completeness: 'complete', degradedReasons: [], errors: [] };
  const runStart = new Date().toISOString();
  let ledger: Ledger | undefined;
  try {
    if (en.processor) run.watermarkBefore = await processorWatermark(chain, en.processor);
    run.enumeration.start = new Date().toISOString();
    const before = state.candidateCount(def.id);
    const result = await en.run(chain, state.cursor(def.id));
    state.upsertCandidates(def.id, result.candidates, runStart, result.incremental);
    if (result.cursor) state.setCursor(def.id, result.cursor);
    Object.assign(run.enumeration, { end: new Date().toISOString(), pages: result.pages, cursor: result.cursor,
      candidates: state.candidateCount(def.id), newCandidates: state.candidateCount(def.id) - before });
    if (en.processor) {
      run.watermarkAfter = await processorWatermark(chain, en.processor);
      const lagMs = Date.now() - Date.parse(run.watermarkAfter.timestamp);
      if (lagMs > WATERMARK_MAX_LAG_MS) run.degradedReasons.push(`indexer ${en.processor} is ${Math.round(lagMs / 60_000)} min behind`);
    }

    ledger = await chain.ledger();
    const ctx: ReadContext = { chain, ledger, memo: state.memo(), scratch: new Map() };
    const enumerated = new Set(result.candidates.map(c => c.owner));
    const due = state.due(def, Date.now(), enumerated);
    const batch = due.slice(0, LIMIT);
    if (batch.length < due.length) run.degradedReasons.push(`limited to ${batch.length} of ${due.length} due owners`);
    run.verification.start = new Date().toISOString();
    run.verification.ledgerFrom = ledger.version;
    let done = 0;
    await mapLimit(batch, CONCURRENCY, async ({ owner, hint }) => {
      if (capHit.hit) return;
      try {
        const r = await def.read(ctx, owner, hint);
        const positions = r.positions.length ? applyOwnerKind(r.positions, await ownerKind(ctx, owner)) : r.positions;
        state.recordRead(def.id, owner, positions, r.complete, runStart);
        run.verification.read++;
        if (!r.complete) run.verification.incomplete++;
        run.errors.push(...r.errors.slice(0, 2));
      } catch (err) {
        if (err instanceof RequestCapReached) { capHit.hit = true; return; }
        state.recordRead(def.id, owner, [], false, runStart);
        run.verification.incomplete++;
        run.errors.push(String(err).slice(0, 200));
      }
      if (++done % 1000 === 0) console.error(`${def.id}: read ${done}/${batch.length}`);
    });
    run.verification.end = new Date().toISOString();
    run.verification.ledgerTo = (await chain.ledger()).version;
    if (capHit.hit) run.degradedReasons.push('request cap reached during verification');
  } catch (err) {
    if (err instanceof RequestCapReached) capHit.hit = true;
    run.degradedReasons.push(`run failed: ${String(err).slice(0, 200)}`);
  }
  run.verification.notReread = state.staleCount(def.id, new Date(Date.parse(runStart) - AGE_LIMIT_MS[def.refresh.nonZero]).toISOString());
  if (run.verification.incomplete) run.degradedReasons.push(`${run.verification.incomplete} owners read incompletely; their previous positions are kept`);
  if (run.verification.notReread) run.degradedReasons.push(`${run.verification.notReread} positions not re-read this run`);
  run.errors = [...new Set(run.errors)].slice(0, 20);
  return { run, ledger };
}

async function main() {
  const state = new State(STATE);
  const { chain, usage } = keyedReader(CAP);
  const previous: Snapshot | undefined = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : undefined;
  const capHit = { hit: false };
  const now = Math.floor(Date.now() / 1000);
  const { prices, errors: priceErrors } = await fetchPrices(now);

  const sources: SnapshotSource[] = [];
  for (const def of SOURCES) {
    const en = ENUMERATORS.find(e => e.sourceId === def.id);
    if (!en) throw new Error(`No enumerator for ${def.id}`);
    const prev = previous?.sources.find(s => s.id === def.id);
    if (ONLY && def.id !== ONLY) { if (prev) sources.push(prev); continue; }
    console.error(`${def.id}: start`);
    const { run, ledger } = capHit.hit
      ? { run: { processor: en.processor, scope: en.scope, enumeration: { pages: 0, newCandidates: 0, candidates: state.candidateCount(def.id) },
          verification: { read: 0, incomplete: 0, notReread: state.positionsOf(def.id).length }, completeness: 'degraded' as const,
          degradedReasons: ['skipped: request cap reached earlier in the run'], errors: [] }, ledger: undefined }
      : await runSource(def, en, state, chain, capHit);
    const positions = state.positionsOf(def.id);
    if (en.sanity && ledger) {
      try { run.sanity = await en.sanity(chain, ledger, positions); if (run.sanity.ok === false) run.degradedReasons.push('sanity check failed'); }
      catch (err) { run.sanity = { check: 'sanity', ok: null, detail: String(err).slice(0, 200) }; }
    }
    if (Object.keys(prices).length === 0) run.degradedReasons.push('no prices');
    run.completeness = run.degradedReasons.length ? 'degraded' : 'complete';
    sources.push({
      id: def.id, title: def.title, summary: def.summary, category: def.category, inclusionRule: def.inclusionRule,
      protocolStatus: def.protocolStatus, howTo: def.howTo, officialUrl: def.officialUrl, headlineAgeBases: def.headlineAgeBases,
      run, lastSuccessAt: run.completeness === 'complete' ? run.verification.end : prev?.lastSuccessAt,
      totals: sourceTotals(def, positions, prices, now), sizeBands: sizeBands(positions, prices),
    });
    console.error(`${def.id}: ${run.completeness} ${run.degradedReasons.join('; ')}`);
  }

  // Global owners are unique across sources.
  const headlineOwners = new Map<string, number>();
  for (const def of SOURCES) for (const p of state.positionsOf(def.id)) {
    const age = ageDays(p, now);
    if (p.status !== 'recoverable' || !headlineAge(def, p) || age === null || age < HEADLINE_AGE_DAYS) continue;
    headlineOwners.set(p.owner, (headlineOwners.get(p.owner) ?? 0) + (usd(p.expectedPayout, prices) ?? 0));
  }
  const snapshot: Snapshot = {
    schema: 1, generatedAt: new Date().toISOString(), prices, priceErrors, sources,
    global: {
      headlineUsd: sources.reduce((s, x) => s + x.totals.headline.usd, 0),
      headlineOwners: headlineOwners.size,
      headlineOwnersMin10: [...headlineOwners.values()].filter(v => v >= 10).length,
      recoverableUsd: sources.reduce((s, x) => s + x.totals.byStatus.recoverable.usd, 0),
      requests: usage.requests, requestCap: CAP,
    },
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(snapshot, null, 2) + '\n');
  state.close();
  console.error(`requests ${usage.requests} ${JSON.stringify(usage.byLabel)} → ${OUT}`);
}

if (import.meta.main) await main();
