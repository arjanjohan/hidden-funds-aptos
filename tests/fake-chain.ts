import type { ChainReader, Ledger, Memo, ReadContext } from '../src/shared/types.ts';

type Handler<A extends unknown[]> = (...args: A) => unknown;

/** A scripted ChainReader. Unscripted calls throw so tests notice unexpected reads. */
export function fakeChain(handlers: {
  view?: Handler<[string, unknown[], string[]]>;
  resource?: Handler<[string, string]>;
  archiveResource?: Handler<[string, string, string]>;
  account?: Handler<[string]>;
  gql?: Handler<[string, Record<string, unknown>]>;
}): ChainReader & { calls: string[] } {
  const calls: string[] = [];
  const call = async <A extends unknown[]>(name: string, h: Handler<A> | undefined, ...args: A) => {
    calls.push(`${name} ${String(args[0])}`);
    if (!h) throw new Error(`unexpected ${name} ${String(args[0])}`);
    return h(...args);
  };
  return {
    calls,
    ledger: async () => ({ version: '100', timestampSecs: 1_800_000_000 }),
    view: (fn, args, typeArgs = []) => call('view', handlers.view, fn, args, typeArgs) as Promise<any[]>,
    resource: (address, type) => call('resource', handlers.resource, address, type),
    account: address => call('account', handlers.account, address) as Promise<any>,
    archiveResource: (address, type, version) => call('archiveResource', handlers.archiveResource, address, type, version),
    gql: (query, variables = {}) => call('gql', handlers.gql, query, variables) as Promise<any>,
  };
}

export function memoryMemo(): Memo & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: async k => data.get(k), set: async (k, v) => { data.set(k, v); } };
}

export function context(chain: ChainReader, ledger: Ledger = { version: '100', timestampSecs: 1_800_000_000 }, memo = memoryMemo()): ReadContext {
  return { chain, ledger, memo, scratch: new Map() };
}

export const addr = (n: number | string) => '0x' + String(n).padStart(64, '0');
