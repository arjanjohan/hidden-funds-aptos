// Who holds a position: an ordinary account, a resource account or an object. Memoized: it does not change.
import { applyOwnerKind, type OwnerKind } from './accounting.ts';
import { normalizeAddress } from './chain.ts';
import type { ReadContext, ReadResult, SourceDef } from './types.ts';

const ZERO_KEY = /^0x0+$/;

/** Framework-reserved addresses 0x0–0xa: nobody signs for them. */
const RESERVED = /^0x0{63}[0-9a]$/;

/** Version of the owner rule (how an owner is classified, and what that does to its positions). Bump it with any change:
 *  cached classifications are then not read, and the pipeline re-reads every owner with stored positions. 2: ObjectCore
 *  decides first; held by a contract is `contract_held` (2026-10-22). */
export const OWNER_RULES = 2;

export async function ownerKind(ctx: ReadContext, owner: string): Promise<OwnerKind> {
  if (RESERVED.test(owner)) return 'resource_account';
  const key = `owner-kind:v${OWNER_RULES}:${owner}`;
  const cached = await ctx.memo.get(key);
  if (cached) return cached as OwnerKind;
  // An object can also carry an account resource (to hold coins), with its own address as the key; nobody holds a key
  // for an object address, so ObjectCore decides first. An address with neither is a key-derived account that never
  // sent a transaction.
  const [account, core] = await Promise.all([ctx.chain.account(owner), ctx.chain.resource(owner, '0x1::object::ObjectCore')]);
  const kind: OwnerKind = core ? 'object' : account && ZERO_KEY.test(account.authentication_key) ? 'resource_account' : 'user';
  await ctx.memo.set(key, kind);
  return kind;
}

/** A source read with the owner rule applied: positions of an owner nobody can sign for (a resource account or an
 *  object) become `contract_held`. The pipeline and the check page both read through this, so they classify alike.
 *  Indexer-only positions never reach a total, so their owner is not looked up. */
export async function readClassified<Hint>(source: SourceDef<Hint>, ctx: ReadContext, owner: string, hint?: Hint): Promise<ReadResult> {
  const r = await source.read(ctx, owner, hint);
  if (!r.positions.some(p => p.confidence !== 'indexer_only')) return r;
  return { ...r, positions: applyOwnerKind(r.positions, await ownerKind(ctx, normalizeAddress(owner))) };
}

