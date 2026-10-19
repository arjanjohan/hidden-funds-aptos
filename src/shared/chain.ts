// Fetch-based ChainReader. Browser-safe: no environment access; credentials are injected by the caller.
import type { ChainReader, Ledger, ReadContext } from './types.ts';

export type Network = 'aptos' | 'movement';

export const NETWORKS: Record<Network, { name: string; fullnode: string; archive: string; indexer: string; chainId: number }> = {
  aptos: {
    name: 'Aptos',
    fullnode: 'https://fullnode.mainnet.aptoslabs.com/v1',
    archive: 'https://archive.mainnet.aptoslabs.com/v1',
    indexer: 'https://api.mainnet.aptoslabs.com/v1/graphql',
    chainId: 1,
  },
  // Movement's fullnode keeps full history (oldest version 0), so it also serves historical reads.
  movement: {
    name: 'Movement',
    fullnode: 'https://mainnet.movementnetwork.xyz/v1',
    archive: 'https://mainnet.movementnetwork.xyz/v1',
    indexer: 'https://indexer.mainnet.movementnetwork.xyz/v1/graphql',
    chainId: 126,
  },
};

export interface ReaderOptions {
  network?: Network;
  headers?: Record<string, string>;
  /** Called before every HTTP request; may throw to stop a run (request cap). */
  onRequest?: (label: string) => void;
  retries?: number;
  timeoutMs?: number;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export function normalizeAddress(address: string): string {
  const hex = address.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{1,64}$/.test(hex)) throw new Error(`Invalid Aptos address: ${address}`);
  return '0x' + hex.padStart(64, '0');
}

export function createReader(options: ReaderOptions = {}): ChainReader {
  const { network = 'aptos', headers = {}, onRequest, retries = 5, timeoutMs = 60_000 } = options;
  const endpoints = NETWORKS[network];

  async function request(url: string, init: RequestInit, label: string, allow404 = false): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      onRequest?.(label);
      let res: Response;
      try {
        res = await fetch(url, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) }, signal: AbortSignal.timeout(timeoutMs) });
      } catch (err: any) {
        // Timeouts and network failures ("fetch failed": reset, DNS, TLS) are transient.
        if ((err?.name === 'TimeoutError' || err instanceof TypeError) && attempt < retries) {
          await sleep(Math.min(60_000, 2_000 * 2 ** attempt));
          continue;
        }
        throw err;
      }
      if (allow404 && res.status === 404) return null;
      const text = await res.text();
      const body = text ? JSON.parse(text) : null;
      const code = body?.errors?.[0]?.extensions?.code;
      const transient = res.status === 429 || res.status === 408 || res.status >= 500 || code === '429' || code === '408';
      if (transient && attempt < retries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(retryAfter > 0 ? Math.min(retryAfter * 1000, 60_000) : Math.min(60_000, 2_000 * 2 ** attempt));
        continue;
      }
      if (!res.ok) throw new Error(`${label}: HTTP ${res.status} ${text.slice(0, 300)}`);
      if (body?.errors) throw new Error(`${label}: ${JSON.stringify(body.errors).slice(0, 300)}`);
      return body;
    }
  }

  const at = (version?: string) => (version ? `?ledger_version=${version}` : '');
  const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  return {
    async ledger(): Promise<Ledger> {
      const body = await request(endpoints.fullnode, {}, 'ledger');
      if (body.chain_id !== endpoints.chainId) throw new Error(`Fullnode is not ${endpoints.name} mainnet`);
      return { version: body.ledger_version, timestampSecs: Math.floor(Number(body.ledger_timestamp) / 1_000_000) };
    },
    view: (fn, args, typeArgs = [], version) =>
      request(`${endpoints.fullnode}/view${at(version)}`, json({ function: fn, type_arguments: typeArgs, arguments: args }), `view ${fn}`),
    resource: async (address, type, version) =>
      (await request(`${endpoints.fullnode}/accounts/${address}/resource/${encodeURIComponent(type)}${at(version)}`, {}, `resource ${type}`, true))?.data ?? null,
    account: address => request(`${endpoints.fullnode}/accounts/${address}`, {}, 'account', true),
    tableItem: (handle, keyType, valueType, key, version) =>
      request(`${endpoints.fullnode}/tables/${handle}/item${at(version)}`, json({ key_type: keyType, value_type: valueType, key }), 'table', true),
    archiveResource: async (address, type, version) =>
      (await request(`${endpoints.archive}/accounts/${address}/resource/${encodeURIComponent(type)}${at(version)}`, {}, `archive ${type}`, true))?.data ?? null,
    gql: async (query, variables = {}) => (await request(endpoints.indexer, json({ query, variables }), 'indexer')).data,
  };
}

/** Run fn over items with bounded concurrency, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

/** Load a value once per run; a failed load is forgotten so a later caller retries. */
export function once<T>(ctx: ReadContext, key: string, load: () => Promise<T>): Promise<T> {
  if (!ctx.scratch.has(key)) ctx.scratch.set(key, load().catch(err => { ctx.scratch.delete(key); throw err; }));
  return ctx.scratch.get(key) as Promise<T>;
}

/** Timestamp (seconds) of a user transaction by version. */
export async function transactionTime(chain: ChainReader, version: number | string): Promise<number | null> {
  const d = await chain.gql<{ user_transactions: { timestamp: string }[] }>(
    'query($v:bigint!){ user_transactions(where:{version:{_eq:$v}}, limit:1){ timestamp } }', { v: String(version) });
  const ts = d.user_transactions[0]?.timestamp;
  return ts ? Math.floor(Date.parse(ts + 'Z') / 1000) : null;
}
