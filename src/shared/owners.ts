// Who holds a position: an ordinary account, a resource account or an object. Memoized: it does not change.
import type { OwnerKind } from './accounting.ts';
import type { ReadContext } from './types.ts';

const ZERO_KEY = /^0x0+$/;

export async function ownerKind(ctx: ReadContext, owner: string): Promise<OwnerKind> {
  const key = `owner-kind:${owner}`;
  const cached = await ctx.memo.get(key);
  if (cached) return cached as OwnerKind;
  const account = await ctx.chain.account(owner);
  // Objects have no account resource. An address with neither is a key-derived account that never sent a transaction.
  const kind: OwnerKind = account
    ? (ZERO_KEY.test(account.authentication_key) ? 'resource_account' : 'user')
    : (await ctx.chain.resource(owner, '0x1::object::ObjectCore')) ? 'object' : 'user';
  await ctx.memo.set(key, kind);
  return kind;
}
