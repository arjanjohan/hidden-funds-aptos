import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequestCapReached } from '../src/node/client.ts';
import type { Enumerator } from '../src/node/enumerators.ts';
import { fetchPrices } from '../src/node/prices.ts';
import { keepPrevious, runSource } from '../src/node/snapshot.ts';
import { State } from '../src/node/state.ts';
import { positionIds } from '../src/shared/accounting.ts';
import type { ChainReader, Position, ReadResult, SourceDef } from '../src/shared/types.ts';
import { addr, fakeChain } from './fake-chain.ts';

const freshWatermark = () => ({ processor_status: [{ last_success_version: 99, last_transaction_timestamp: new Date().toISOString().slice(0, -1) }] });

function position(owner: string, raw = '100'): Position {
  const amount = [{ asset: 'apt', raw }];
  return { ...positionIds('t', owner, 'x', 'principal'), source: 't', owner, locator: 'x', positionKind: 'principal', ageBasis: 'unknown',
    provenance: { reader: 'test', ledgerVersion: '1' }, grossClaim: amount, expectedPayout: amount, payoutBasis: 'view',
    status: 'recoverable', blockers: [], confidence: 'verified_view', observedAt: '2026-10-18T00:00:00Z', steps: [] };
}

function source(read: (owner: string) => Promise<ReadResult>): SourceDef {
  return { id: 't', chain: 'aptos', protocol: 'Test', title: '', summary: '', category: 'staking', inclusionRule: '', howTo: [],
    protocolStatus: { state: 'live', evidence: '', checkedAt: '' }, refresh: { nonZero: 'every_run', zero: 'weekly' },
    headlineAgeBases: ['onchain_maturity'], read: (_ctx, owner) => read(owner) };
}

const enumerator = (owners: string[], fail = false): Enumerator => ({
  sourceId: 't', processor: 'p', scope: 'test',
  run: async () => { if (fail) throw new Error('indexer 503'); return { candidates: owners.map(owner => ({ owner })), pages: 1 }; },
});

const chain = (watermark = freshWatermark, authKey?: string): ChainReader => fakeChain({
  gql: () => watermark(),
  resource: () => null,
  account: (address: string) => ({ authentication_key: authKey ?? address, sequence_number: '1' }),
});

describe('runSource', () => {
  it('reports an indexer failure mid-enumeration as degraded', async () => {
    const { run } = await runSource(source(async () => { throw new Error('unreachable'); }), enumerator([], true), new State(':memory:'), chain(), { hit: false });
    expect(run.degradedReasons.join()).toMatch(/run failed: Error: indexer 503/);
  });

  it('reports a lagging indexer watermark as degraded', async () => {
    const stale = () => ({ processor_status: [{ last_success_version: 1, last_transaction_timestamp: '2026-01-01T00:00:00' }] });
    const { run } = await runSource(source(async () => ({ positions: [], complete: true, errors: [], ledgerVersion: '1' })),
      enumerator([addr(1)]), new State(':memory:'), chain(stale), { hit: false });
    expect(run.degradedReasons.join()).toMatch(/behind/);
  });

  it('keeps previous positions when a revalidation read is incomplete', async () => {
    const state = new State(':memory:');
    const owner = addr(1);
    await runSource(source(async o => ({ positions: [position(o)], complete: true, errors: [], ledgerVersion: '1' })), enumerator([owner]), state, chain(), { hit: false });
    const { run } = await runSource(source(async () => ({ positions: [], complete: false, errors: ['view failed'], ledgerVersion: '2' })),
      enumerator([owner]), state, chain(), { hit: false });
    expect(state.positionsOf('t').map(p => p.owner)).toEqual([owner]);
    expect(run.verification.incomplete).toBe(1);
    expect(run.degradedReasons.join()).toMatch(/incompletely/);
  });

  it('stops at the request cap even when the source catches the reader error', async () => {
    const capHit = { hit: false };
    let reads = 0;
    const capped: ChainReader = { ...chain(), view: async () => { throw new RequestCapReached('cap'); } };
    const def: SourceDef = { ...source(async () => ({ positions: [], complete: true, errors: [], ledgerVersion: '1' })),
      read: async (ctx, owner) => {
        reads++;
        try { await ctx.chain.view('0x1::a::b', [owner]); return { positions: [], complete: true, errors: [], ledgerVersion: '1' }; }
        catch (err) { return { positions: [], complete: false, errors: [String(err)], ledgerVersion: '1' }; }
      } };
    const { run } = await runSource(def, enumerator([addr(1), addr(2), addr(3), addr(4), addr(5), addr(6), addr(7), addr(8), addr(9), addr('a1')]), new State(':memory:'), capped, capHit);
    expect(capHit.hit).toBe(true);
    expect(reads).toBeLessThan(10);
    expect(run.degradedReasons.join()).toMatch(/request cap/);
  });

  it('stops at the request cap and says so', async () => {
    const capHit = { hit: false };
    const { run } = await runSource(source(async () => { throw new RequestCapReached('cap'); }), enumerator([addr(1), addr(2)]),
      new State(':memory:'), chain(), capHit);
    expect(capHit.hit).toBe(true);
    expect(run.degradedReasons.join()).toMatch(/request cap/);
  });
});

describe('market evidence', () => {
  it('re-runs a market-dependent source in a single-source run once its quotes have expired', () => {
    const now = Date.parse('2026-10-20T00:00:00Z') / 1000;
    const kofi = { ...source(async () => { throw new Error(); }), id: 'k', usesMarketQuotes: true } as SourceDef;
    const plain = { ...source(async () => { throw new Error(); }), id: 'p' } as SourceDef;
    const prev = (end: string) => ({ run: { verification: { end } } }) as any;
    expect(keepPrevious(plain, prev('2026-09-01T00:00:00Z'), 'x', now)).toBe(true);
    expect(keepPrevious(kofi, prev('2026-10-18T00:00:00Z'), 'x', now)).toBe(true);
    expect(keepPrevious(kofi, prev('2026-10-01T00:00:00Z'), 'x', now)).toBe(false);
    expect(keepPrevious(kofi, undefined, 'x', now)).toBe(false);
  });

  it('reports a run whose receipt positions have no market quote as degraded', async () => {
    const blocked: Position = { ...position(addr(1)), status: 'unknown', blockers: [{ code: 'market_check_unavailable', detail: '' }] };
    const { run } = await runSource(source(async () => ({ positions: [blocked], complete: true, errors: [], ledgerVersion: '1' })),
      enumerator([addr(1)]), new State(':memory:'), chain(), { hit: false });
    expect(run.degradedReasons.join()).toMatch(/without market evidence/);
  });
});

describe('owner rule', () => {
  it('keeps positions held by a resource account visible but unknown', async () => {
    const state = new State(':memory:');
    await runSource(source(async o => ({ positions: [position(o)], complete: true, errors: [], ledgerVersion: '1' })),
      enumerator([addr(1)]), state, chain(freshWatermark, '0x' + '0'.repeat(64)), { hit: false });
    const [p] = state.positionsOf('t');
    expect(p.status).toBe('unknown');
    expect(p.blockers.map(b => b.code)).toEqual(['unsupported_owner']);
  });

  it('leaves positions held by an ordinary account unchanged', async () => {
    const state = new State(':memory:');
    await runSource(source(async o => ({ positions: [position(o)], complete: true, errors: [], ledgerVersion: '1' })),
      enumerator([addr('b1')]), state, chain(), { hit: false });
    expect(state.positionsOf('t')[0].status).toBe('recoverable');
  });
});

describe('state', () => {
  it('re-reads non-zero owners every run and zero owners weekly', () => {
    const state = new State(':memory:');
    const def = source(async () => { throw new Error(); });
    state.upsertCandidates('t', [{ owner: addr(1) }, { owner: addr(2) }, { owner: addr(3) }], '2026-10-01T00:00:00Z');
    const now = new Date().toISOString();
    state.recordRead('t', addr(1), [position(addr(1))], true, now);
    state.recordRead('t', addr(2), [], true, now);
    const due = state.due(def, Date.now(), new Set()).map(d => d.owner);
    expect(due).toContain(addr(1));      // non-zero
    expect(due).not.toContain(addr(2));  // zero, read just now
    expect(due).toContain(addr(3));      // never read
  });

  it('never re-reads a zero owner of a never-refresh source unless the enumerator reports it', () => {
    const state = new State(':memory:');
    const def = { ...source(async () => { throw new Error(); }), refresh: { nonZero: 'monthly', zero: 'never' } } as SourceDef;
    state.upsertCandidates('t', [{ owner: addr(1) }], '2026-01-01T00:00:00Z');
    state.recordRead('t', addr(1), [], true, '2026-01-01T00:00:00Z');
    expect(state.due(def, Date.parse('2027-01-01T00:00:00Z'), new Set())).toEqual([]);
    state.upsertCandidates('t', [{ owner: addr(1) }], '2027-01-01T00:00:00Z', true);
    expect(state.due(def, Date.parse('2027-01-01T00:00:00Z'), new Set()).map(d => d.owner)).toEqual([addr(1)]);
  });

  it('spreads monthly re-reads over four weekly runs and reads everyone within 35 days', () => {
    const state = new State(':memory:');
    const def = { ...source(async () => { throw new Error(); }), refresh: { nonZero: 'monthly', zero: 'monthly' } } as SourceDef;
    const owners = Array.from({ length: 64 }, (_, i) => addr((0xb00 + i).toString(16)));
    const readAt = Date.parse('2026-10-05T03:00:00Z');
    state.upsertCandidates('t', owners.map(owner => ({ owner })), new Date(readAt).toISOString());
    for (const o of owners) state.recordRead('t', o, [position(o)], true, new Date(readAt).toISOString());
    const dueAt = (days: number) => state.due(def, readAt + days * 86_400_000, new Set()).map(d => d.owner);
    expect(dueAt(14)).toEqual([]);
    const weeks = [21, 28, 35].map(d => dueAt(d).length);
    expect(weeks[0]).toBeGreaterThan(0);
    expect(weeks[0]).toBeLessThan(owners.length);
    expect(dueAt(35).length).toBe(owners.length);
  });
});

describe('state changes', () => {
  const def = () => source(async () => { throw new Error(); });

  it('makes an owner with positions due when a full scan no longer returns it', async () => {
    const state = new State(':memory:');
    const monthly = { ...def(), refresh: { nonZero: 'monthly', zero: 'monthly' } } as SourceDef;
    state.upsertCandidates('t', [{ owner: addr(1) }, { owner: addr(2) }], '2026-10-01T00:00:00Z');
    state.recordRead('t', addr(1), [position(addr(1))], true, '2026-10-01T00:00:01Z');
    state.recordRead('t', addr(2), [position(addr(2))], true, '2026-10-01T00:00:01Z');
    expect(state.due(monthly, Date.parse('2026-10-02T00:00:00Z'), new Set())).toEqual([]);
    state.markGone('t', new Set([addr(1)]), '2026-10-02T00:00:00Z');
    expect(state.due(monthly, Date.parse('2026-10-02T00:00:00Z'), new Set()).map(d => d.owner)).toEqual([addr(2)]);
  });

  it('makes a zero owner due again when an activity scan returns it', () => {
    const state = new State(':memory:');
    state.upsertCandidates('t', [{ owner: addr(1) }], '2026-10-01T00:00:00Z');
    state.recordRead('t', addr(1), [], true, '2026-10-01T00:00:01Z');
    expect(state.due(def(), Date.parse('2026-10-02T00:00:00Z'), new Set())).toEqual([]);
    state.upsertCandidates('t', [{ owner: addr(1) }], '2026-10-02T00:00:00Z', true);
    expect(state.due(def(), Date.parse('2026-10-02T00:00:00Z'), new Set()).map(d => d.owner)).toEqual([addr(1)]);
  });

  it('makes an owner due when its hint changes, and not when it stays the same', () => {
    const state = new State(':memory:');
    state.upsertCandidates('t', [{ owner: addr(1), hint: { version: 1 } }], '2026-10-01T00:00:00Z');
    state.recordRead('t', addr(1), [], true, '2026-10-01T00:00:01Z');
    state.upsertCandidates('t', [{ owner: addr(1), hint: { version: 1 } }], '2026-10-02T00:00:00Z');
    expect(state.due(def(), Date.parse('2026-10-02T00:00:00Z'), new Set())).toEqual([]);
    state.upsertCandidates('t', [{ owner: addr(1), hint: { version: 2 } }], '2026-10-03T00:00:00Z');
    expect(state.due(def(), Date.parse('2026-10-03T00:00:00Z'), new Set()).map(d => d.owner)).toEqual([addr(1)]);
  });

  it('merges an incremental hint into the stored one and reads with it', () => {
    const state = new State(':memory:');
    state.upsertCandidates('t', [{ owner: addr(1), hint: { versions: { a: 1 } } }, { owner: addr(2), hint: { versions: { a: 5 } } }], '2026-10-01T00:00:00Z', true);
    state.upsertCandidates('t', [{ owner: addr(1), hint: { versions: { b: 2 } } }], '2026-10-02T00:00:00Z', true);
    const due = state.due(def(), Date.parse('2026-10-02T00:00:00Z'), new Set([addr(1)]), true);
    expect(due.find(d => d.owner === addr(1))?.hint).toEqual({ versions: { a: 1, b: 2 } });
    expect(due.find(d => d.owner === addr(2))?.hint).toEqual({ versions: { a: 5 } });
  });

  it('adds the changed_at column to a state file written before it existed', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'state-')), 'old.sqlite');
    const old = new DatabaseSync(path);
    old.exec('create table candidates (source text, owner text, hint text, first_seen text, last_read_at text, last_nonzero integer, last_complete integer, primary key (source, owner))');
    old.close();
    const state = new State(path);
    state.upsertCandidates('t', [{ owner: addr(1) }], '2026-10-01T00:00:00Z');
    expect(state.candidateCount('t')).toBe(1);
  });
});

describe('prices', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns no price, with an error, when the provider is down', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('ECONNRESET'); });
    const { prices, errors } = await fetchPrices(1_800_000_000);
    expect(prices).toEqual({});
    expect(errors[0]).toMatch(/coingecko/);
  });

  it('refuses a quote older than 7 days', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ aptos: { usd: 1, last_updated_at: 1_800_000_000 - 8 * 86_400 } })));
    const { prices, errors } = await fetchPrices(1_800_000_000);
    expect(prices).toEqual({});
    expect(errors[0]).toMatch(/older than 7 days/);
  });
});

describe('source version', () => {
  it('re-reads every candidate when a source\'s rules change', async () => {
    const state = new State(':memory:');
    const owner = addr(1);
    let reads = 0;
    const read = async (o: string) => { reads++; return { positions: [position(o)], complete: true, errors: [], ledgerVersion: '1' }; };
    const def = { ...source(read), refresh: { nonZero: 'monthly' as const, zero: 'monthly' as const } };
    await runSource(def, enumerator([owner]), state, chain(), { hit: false });
    await runSource(def, enumerator([owner]), state, chain(), { hit: false });
    expect(reads).toBe(1);                              // monthly: not due again
    await runSource({ ...def, version: 2 }, enumerator([owner]), state, chain(), { hit: false });
    expect(reads).toBe(2);                              // new rules: due at once
  });
});
