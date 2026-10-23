// Wormhole Portal transfers to Aptos that were never redeemed: the tokens left the source chain, and the signed VAA that
// mints or releases them on Aptos was never submitted. Nothing is recorded on Aptos until redemption, so the transfers
// come from Wormholescan's per-address history (a third party, opt-in on the check page; decided 2026-10-22). Each one is
// then checked on chain: it must come from the token bridge registered for its source chain (what `complete_transfer`
// accepts), and a VAA the token bridge consumed (its `consumed_vaas` set, keyed by the body's double keccak) was
// redeemed. Check-only: Wormholescan has no chain-wide listing of unredeemed transfers to Aptos.
import { iso, positionIds } from '../accounting.ts';
import { keccak256 } from '../keccak.ts';
import { normalizeAddress, once } from '../chain.ts';
import type { Position, ReadContext, ReadResult, SourceDef } from '../types.ts';
import { assetOf } from './animeswap-closed.ts';

export const WH_TOKEN_BRIDGE = '0x576410486a2da45eee6c949c995670112ddf2fbeedab20350d506328eefc9d4f';
export const WH_CORE = '0x5bc11445584a763c1fa7ed39081f1b920954da14e04b32440cba863d03e19625';
export const WORMHOLESCAN = 'https://api.wormholescan.io/api/v1';
const APTOS_CHAIN = 22;
/** Operations read per owner (100 a page). */
const MAX_PAGES = 10;
const SOURCE = 'wormhole-unredeemed';

const toHex = (b: Uint8Array) => '0x' + [...b].map(x => x.toString(16).padStart(2, '0')).join('');
const fromBase64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const uint = (b: Uint8Array, from: number, len: number) => b.subarray(from, from + len).reduce((v, x) => (v << 8n) | BigInt(x), 0n);

export interface PortalTransfer { guardianSet: number; body: Uint8Array; timestamp: number; emitterChain: number; emitter: string; amount: bigint;
  tokenAddress: Uint8Array; tokenChain: number; to: string; toChain: number }

/** A signed VAA's body and, for a Portal token transfer (payload 1), its fields; null for anything else. */
export function portalTransfer(vaa: Uint8Array): PortalTransfer | null {
  const signatures = vaa[5];
  const body = vaa.subarray(6 + 66 * signatures);
  // Body: timestamp 4, nonce 4, emitter chain 2, emitter 32, sequence 8, consistency 1, then the payload.
  const p = body.subarray(51);
  if (p[0] !== 1 || p.length < 133) return null;
  return { guardianSet: Number(uint(vaa, 1, 4)), body, timestamp: Number(uint(body, 0, 4)), emitterChain: Number(uint(body, 8, 2)), emitter: toHex(body.subarray(10, 42)),
    amount: uint(p, 1, 32), tokenAddress: p.subarray(33, 65), tokenChain: Number(uint(p, 65, 2)), to: normalizeAddress(toHex(p.subarray(67, 99))), toChain: Number(uint(p, 99, 2)) };
}

const bridgeState = (ctx: ReadContext) => once(ctx, `wormhole-state:${ctx.ledger.version}`, async () => {
  const [s, core] = await Promise.all([ctx.chain.resource(WH_TOKEN_BRIDGE, `${WH_TOKEN_BRIDGE}::state::State`, ctx.ledger.version),
    ctx.chain.resource(WH_CORE, `${WH_CORE}::state::WormholeState`, ctx.ledger.version)]);
  if (!s || !core) throw new Error('Wormhole state missing');
  return { consumed: s.consumed_vaas.elems.handle as string, wrapped: s.wrapped_infos.handle as string, native: s.native_infos.handle as string,
    emitters: s.registered_emitters.handle as string, guardianSets: core.guardian_sets.handle as string, guardianSet: Number(core.guardian_set_index.number) };
});

/** Whether a guardian set still verifies VAAs, as the core contract's `guardian_set_is_active` decides: the current set,
 *  or a superseded one until its expiry (a day after the rotation). */
const guardianSetActive = (ctx: ReadContext, index: number) => once(ctx, `wormhole-guardian-set:${index}:${ctx.ledger.version}`, async () => {
  const s = await bridgeState(ctx);
  if (index === s.guardianSet) return true;
  const set = await ctx.chain.tableItem(s.guardianSets, 'u64', `${WH_CORE}::structs::GuardianSet`, String(index), ctx.ledger.version);
  return !!set && Number(set.expiration_time.number) > ctx.ledger.timestampSecs;
});

const EMITTER_QUERY = `query($h:String!,$k:jsonb!){ current_table_items(where:{table_handle:{_eq:$h}, decoded_key:{_eq:$k}, is_deleted:{_eq:false}}, limit:1){ decoded_value } }`;

/** The token bridge registered for a source chain (by governance; null if none), from the indexer: the fullnode's table
 *  API cannot parse the key type (`…::u16::U16`). */
const registeredEmitter = (ctx: ReadContext, chainId: number) => once(ctx, `wormhole-emitter:${chainId}`, async () => {
  const s = await bridgeState(ctx);
  const [row] = (await ctx.chain.gql(EMITTER_QUERY, { h: s.emitters, k: { number: String(chainId) } })).current_table_items;
  return row ? String(row.decoded_value.external_address).toLowerCase() : null;
});

const typeName = (t: { account_address: string; module_name: string; struct_name: string }) => {
  const text = (h: string) => new TextDecoder().decode(Uint8Array.from(h.slice(2).match(/../g) ?? [], x => parseInt(x, 16)));
  const a = normalizeAddress(t.account_address);
  return `${a === normalizeAddress('0x1') ? '0x1' : a}::${text(t.module_name)}::${text(t.struct_name)}`;
};

/** The Aptos coin a transfer pays: the native coin it came from, or the token's wrapped coin; null if never attested. */
async function coinOf(ctx: ReadContext, t: PortalTransfer): Promise<string | null> {
  const s = await bridgeState(ctx);
  if (t.tokenChain === APTOS_CHAIN) {
    const info = await ctx.chain.tableItem(s.native, `${WH_TOKEN_BRIDGE}::token_hash::TokenHash`, '0x1::type_info::TypeInfo', { hash: toHex(t.tokenAddress) }, ctx.ledger.version);
    return info ? typeName(info) : null;
  }
  const info = await ctx.chain.tableItem(s.wrapped, `${WH_TOKEN_BRIDGE}::state::OriginInfo`, `${WH_TOKEN_BRIDGE}::state::WrappedInfo`,
    { token_chain: { number: String(t.tokenChain) }, token_address: { external_address: toHex(t.tokenAddress) } }, ctx.ledger.version);
  return info?.type_info?.vec?.[0] ? typeName(info.type_info.vec[0]) : null;
}

async function read(ctx: ReadContext, ownerInput: string): Promise<ReadResult> {
  const owner = normalizeAddress(ownerInput);
  const version = ctx.ledger.version;
  const positions: Position[] = [];
  const errors: string[] = [];
  try {
    const ops: any[] = [];
    for (let page = 0; ; page++) {
      // Bounded, so a stalled third party leaves the read incomplete instead of hanging the check page.
      const res = await fetch(`${WORMHOLESCAN}/operations?address=${owner}&page=${page}&pageSize=100`, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`Wormholescan: HTTP ${res.status}`);
      const list = (await res.json()).operations ?? [];
      ops.push(...list);
      if (list.length < 100) break;
      if (page + 1 >= MAX_PAGES) { errors.push(`only the latest ${MAX_PAGES * 100} Wormholescan operations read`); break; }
    }
    const s = await bridgeState(ctx);
    for (const op of ops) {
      if (!op.vaa?.raw) continue;
      const t = portalTransfer(fromBase64(op.vaa.raw));
      if (!t || t.toChain !== APTOS_CHAIN || t.to !== owner) continue;
      // Only the registered token bridge's messages are transfers: anything else that parses as one is not redeemable.
      if (await registeredEmitter(ctx, t.emitterChain) !== t.emitter) continue;
      // Redeemed: the bridge recorded the VAA's digest.
      const digest = toHex(keccak256(keccak256(t.body)));
      if (await ctx.chain.tableItem(s.consumed, 'vector<u8>', `${WH_CORE}::set::Unit`, digest, version)) continue;
      const coin = await coinOf(ctx, t);
      // Amounts travel with 8 decimals; a coin with more is scaled up on redemption.
      const decimals = coin ? Number((await ctx.chain.view('0x1::coin::decimals', [], [coin], version))[0]) : 8;
      const raw = (decimals > 8 ? t.amount * 10n ** BigInt(decimals - 8) : t.amount).toString();
      const asset = coin ? assetOf(coin) : `wormhole:${t.tokenChain}:${toHex(t.tokenAddress)}`;
      const value = [{ asset, raw }];
      // Aptos verifies a VAA against its guardian set; superseded sets expire a day after a rotation (simulated: an
      // older VAA aborts with E_GUARDIAN_SET_EXPIRED), so it needs a fresh signature from Wormhole's guardians first.
      const blocker = !coin ? { code: 'not_attested', detail: 'The token has no Wormhole-wrapped coin on Aptos yet; it must be attested before the transfer can be redeemed.' }
        : !(await guardianSetActive(ctx, t.guardianSet)) ? { code: 'guardian_set_expired', detail: `Signed by Wormhole guardian set ${t.guardianSet}, which has expired (now ${s.guardianSet}); the guardians must sign the transfer again (re-observation) before it can be redeemed.` }
        : null;
      const gated = blocker?.code === 'guardian_set_expired';
      const locator: string = op.id;
      positions.push({
        ...positionIds(SOURCE, owner, locator, 'request', asset), source: SOURCE, owner, locator, positionKind: 'request', asset,
        claimableSince: iso(t.timestamp), ageBasis: 'onchain_maturity',
        provenance: { reader: `wormholescan operations + ${WH_TOKEN_BRIDGE}::state::State.consumed_vaas`, ledgerVersion: version },
        // Re-signed by the guardians, the transfer pays in full: a team-gated position keeps its payout.
        grossClaim: value, expectedPayout: !blocker || gated ? value : [], payoutBasis: 'derived',
        status: !blocker ? 'recoverable' : gated ? 'team_gated' : 'unknown',
        blockers: blocker ? [blocker] : [],
        confidence: 'verified_view', observedAt: iso(ctx.ledger.timestampSecs),
        steps: [{ function: `${WH_TOKEN_BRIDGE}::complete_transfer::submit_vaa_and_register_entry<${coin ?? 'wrapped coin'}>`,
          arguments: [toHex(fromBase64(op.vaa.raw))], prerequisites: blocker?.code === 'guardian_set_expired' ? ['A re-signed VAA from Wormhole\'s guardians (re-observation)'] : [],
          expectedOutputs: !blocker || gated ? value : [] }],
      });
    }
  } catch (err) {
    return { positions, complete: false, errors: [...errors, String(err).slice(0, 300)], ledgerVersion: version };
  }
  return { positions, complete: errors.length === 0, errors, ledgerVersion: version };
}

export const wormholeUnredeemed: SourceDef = {
  id: SOURCE,
  chain: 'aptos',
  protocol: 'Wormhole (Portal)',
  title: 'Wormhole transfers to Aptos never redeemed',
  summary: 'Tokens sent to Aptos through Wormhole\'s Portal bridge that were never claimed on Aptos: they left the source chain, but the final step that pays them out on Aptos was never done.',
  category: 'bridge',
  inclusionRule: 'R1: a transfer pays out only when its VAA is submitted on Aptos. Found through Wormholescan (opt-in, decided 2026-10-22); unredeemed is checked on chain (the token bridge\'s consumed VAAs). Check-only.',
  protocolStatus: { state: 'live', evidence: 'Wormhole Portal still bridges to Aptos.', checkedAt: '2026-10-22' },
  refresh: { nonZero: 'monthly', zero: 'monthly' },
  headlineAgeBases: ['onchain_maturity'],
  checkOnly: true,
  thirdParty: 'Wormholescan (api.wormholescan.io)',
  howTo: [
    `Call ${WH_TOKEN_BRIDGE}::complete_transfer::submit_vaa_and_register_entry<coin>(VAA) from the receiving address; it registers the coin if needed and pays the transfer.`,
    'The VAA is the signed message Wormholescan shows for the transfer; portalbridge.com can also redeem it.',
  ],
  read,
};
