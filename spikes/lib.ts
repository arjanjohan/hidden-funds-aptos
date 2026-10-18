// Phase 0 spike client: indexer GraphQL + fullnode REST with retries and a request log.
// Run spikes with: node --experimental-strip-types spikes/<name>.ts
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

export const FULLNODE = 'https://fullnode.mainnet.aptoslabs.com/v1';
export const ARCHIVE = 'https://archive.mainnet.aptoslabs.com/v1';
export const INDEXER = 'https://api.mainnet.aptoslabs.com/v1/graphql';

function loadKey(): string {
  const line = readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').find(l => l.startsWith('GEOMI_API_KEY='));
  const key = line?.slice('GEOMI_API_KEY='.length).trim();
  if (!key) throw new Error('GEOMI_API_KEY missing from .env');
  return key;
}
const KEY = loadKey();

// Every request is counted and logged so query cost and runtime can be reported.
export const stats = { requests: 0, retries: 0, bytes: 0, ms: 0 };
let logFile: string | undefined;

export function startLog(name: string) {
  mkdirSync('data/logs', { recursive: true });
  logFile = `data/logs/${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
  return logFile;
}

function log(entry: object) {
  if (logFile) appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function request(url: string, init: RequestInit, label: string): Promise<{ body: any; headers: Headers }> {
  for (let attempt = 0; ; attempt++) {
    const started = Date.now();
    let status = 0;
    try {
      const res = await fetch(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(60_000) });
      status = res.status;
      const text = await res.text();
      const ms = Date.now() - started;
      stats.requests++; stats.bytes += text.length; stats.ms += ms;
      log({ label, status, ms, bytes: text.length });
      const body = text ? JSON.parse(text) : null;
      const throttled = status === 429 || body?.errors?.some((e: any) => e?.extensions?.code === '429');
      const transient = status >= 500 || status === 408 || body?.errors?.some((e: any) => e?.extensions?.code === '408');
      if ((throttled || transient) && attempt < 5) {
        stats.retries++;
        await sleep(Math.min(60_000, 2_000 * 2 ** attempt));
        continue;
      }
      if (status >= 400) throw new Error(`${label}: HTTP ${status} ${text.slice(0, 300)}`);
      return { body, headers: res.headers };
    } catch (err: any) {
      if (err?.name === 'TimeoutError' && attempt < 5) { stats.retries++; log({ label, status: 'timeout' }); continue; }
      throw err;
    }
  }
}

export async function gql<T = any>(query: string, variables: object = {}, label = 'gql'): Promise<T> {
  const { body } = await request(INDEXER, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) }, label);
  if (body.errors) throw new Error(`${label}: ${JSON.stringify(body.errors).slice(0, 500)}`);
  return body.data;
}

export async function ledger(): Promise<{ version: string; timestampUs: string; oldest: string }> {
  const { body } = await request(FULLNODE, {}, 'ledger');
  if (body.chain_id !== 1) throw new Error('Not Aptos mainnet');
  return { version: body.ledger_version, timestampUs: body.ledger_timestamp, oldest: body.oldest_ledger_version };
}

export async function view(fn: string, args: unknown[], typeArgs: string[] = [], ledgerVersion?: string): Promise<any[]> {
  const url = `${FULLNODE}/view${ledgerVersion ? `?ledger_version=${ledgerVersion}` : ''}`;
  const { body } = await request(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ function: fn, type_arguments: typeArgs, arguments: args }) }, `view ${fn}`);
  return body;
}

export async function resource(address: string, type: string, ledgerVersion?: string): Promise<any> {
  const url = `${FULLNODE}/accounts/${address}/resource/${encodeURIComponent(type)}${ledgerVersion ? `?ledger_version=${ledgerVersion}` : ''}`;
  return (await request(url, {}, `resource ${type}`)).body;
}

// Historical reads older than the fullnode's pruning window (~150M versions).
export async function archive(path: string): Promise<any> {
  return (await request(ARCHIVE + path, {}, `archive ${path.split('?')[0].replace(/0x[0-9a-f]+/g, '…')}`)).body;
}

export async function processorWatermark(processor: string) {
  const data = await gql(`query($p:String!){ processor_status(where:{processor:{_eq:$p}}){ processor last_success_version last_transaction_timestamp } }`, { p: processor }, 'processor_status');
  return data.processor_status[0];
}

// Run fn over items with bounded concurrency, preserving order.
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

export async function aptUsd(): Promise<{ usd: number; at: number }> {
  const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=aptos&vs_currencies=usd&include_last_updated_at=true');
  const body: any = await res.json();
  return { usd: body.aptos.usd, at: body.aptos.last_updated_at };
}

export function writeJson(path: string, value: unknown) {
  const dir = path.slice(0, path.lastIndexOf('/'));
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));
}

export const normalize = (a: string) => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
