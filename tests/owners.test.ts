import { describe, expect, it } from 'vitest';
import { positionIds } from '../src/shared/accounting.ts';
import { readClassified } from '../src/shared/owners.ts';
import type { Position, SourceDef } from '../src/shared/types.ts';
import { addr, context, fakeChain } from './fake-chain.ts';

const OWNER = addr('b5');

function source(confidence: Position['confidence']): SourceDef {
  const position: Position = { ...positionIds('t', OWNER, 'x', 'principal'), source: 't', owner: OWNER, locator: 'x', positionKind: 'principal',
    ageBasis: 'unknown', provenance: { reader: 'test', ledgerVersion: '1' }, grossClaim: [{ asset: 'a', raw: '1' }],
    expectedPayout: [{ asset: 'a', raw: '1' }], payoutBasis: 'view', status: 'recoverable', blockers: [], confidence,
    observedAt: '2026-10-20T00:00:00Z', steps: [] };
  return { id: 't', chain: 'aptos', protocol: 'T', title: '', summary: '', category: 'staking', inclusionRule: '', howTo: [],
    protocolStatus: { state: 'live', evidence: '', checkedAt: '' }, refresh: { nonZero: 'every_run', zero: 'monthly' },
    headlineAgeBases: ['onchain_maturity'], read: async () => ({ positions: [position], complete: true, errors: [], ledgerVersion: '1' }) };
}

describe('readClassified', () => {
  it('marks positions of a resource account unknown, as the pipeline does', async () => {
    const chain = fakeChain({ account: () => ({ authentication_key: '0x' + '0'.repeat(64), sequence_number: '0' }) });
    const r = await readClassified(source('verified_view'), context(chain), OWNER);
    expect(r.positions[0]).toMatchObject({ status: 'unknown', blockers: [{ code: 'unsupported_owner' }] });
  });

  it('leaves an ordinary account\'s positions claimable', async () => {
    const chain = fakeChain({ account: () => ({ authentication_key: OWNER, sequence_number: '3' }) });
    expect((await readClassified(source('verified_view'), context(chain), OWNER)).positions[0].status).toBe('recoverable');
  });

  it('does not look up the owner for indexer-only positions', async () => {
    const chain = fakeChain({});
    await readClassified(source('indexer_only'), context(chain), OWNER);
    expect(chain.calls).toEqual([]);
  });
});
