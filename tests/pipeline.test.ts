import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequestCapReached } from '../src/node/client.ts';
import type { Enumerator } from '../src/node/enumerators.ts';
import { fetchPrices } from '../src/node/prices.ts';
import { runSource } from '../src/node/snapshot.ts';
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
  return { id: 't', chain: 'aptos', title: '', summary: '', category: 'staking', inclusionRule: '', howTo: [],
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

  it('stops at the request cap and says so', async () => {
    const capHit = { hit: false };
    const { run } = await runSource(source(async () => { throw new RequestCapReached('cap'); }), enumerator([addr(1), addr(2)]),
      new State(':memory:'), chain(), capHit);
    expect(capHit.hit).toBe(true);
    expect(run.degradedReasons.join()).toMatch(/request cap/);
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
      enumerator([addr(1)]), state, chain(), { hit: false });
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
});

describe('state changes', () => {
  const def = () => source(async () => { throw new Error(); });

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
