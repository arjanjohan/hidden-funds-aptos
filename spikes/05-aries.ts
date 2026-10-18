// Phase 0, shape 5: per-user resource → derived profile accounts → linked-table walk — Aries (wound down July 2026,
// admin multisig moved reserve cash out 2026-06-26..08-17). Counted as `blocked`; this measures face vs recoverable.
//
// Enumerate:  senders of controller::register_user[_with_referrer] (user_transactions, composite filter).
// Sample:     deterministic seeded shuffle of senders (seed + size recorded); per-user reads are heavy.
// Verify:     Profiles → Profile.deposited_reserves walk (table_item) → profile::profile_deposit<T>(user, name)
//             now (contract quote) and at a pre-drain version via the archive (face). Any borrow entry → R4, excluded.
//
// Usage: node --experimental-strip-types --no-warnings spikes/05-aries.ts [--sample N] [--seed S] [--fresh]
import { existsSync, readFileSync } from 'node:fs';
import { ARCHIVE, FULLNODE, archive, gql, ledger, mapLimit, normalize, processorWatermark, startLog, stats, writeJson } from './lib.ts';

const ARIES = '0x9770fa9c725cbd97eb50b2be5f7416efdfd1f1554beb0750d4dae4c64e860da3';
const FUNCTIONS = ['register_user', 'register_user_with_referrer'];
const DRAIN_START = Date.parse('2026-06-25T00:00:00Z') / 1000;   // last day before the first admin withdrawal
const DIR = 'data/aries';
const args = process.argv.slice(2);
const arg = (name: string, fallback: number) => args.includes(name) ? Number(args[args.indexOf(name) + 1]) : fallback;
const SAMPLE = arg('--sample', 1500);
const SEED = arg('--seed', 20261018);
const FRESH = args.includes('--fresh');
const KEY = readFileSync('.env', 'utf8').match(/^GEOMI_API_KEY=(.*)$/m)![1].trim();
const TYPE_INFO = '0x1::type_info::TypeInfo';

const QUERY = `query($c:String!,$m:String!,$f:String!,$after:bigint!){
  user_transactions(where:{entry_function_contract_address:{_eq:$c}, entry_function_module_name:{_eq:$m},
    entry_function_function_name:{_eq:$f}, version:{_gt:$after}}, order_by:{version:asc}, limit:100){ version sender } }`;

async function enumerate() {
  const cache = `${DIR}/senders.json`;
  if (!FRESH && existsSync(cache)) return JSON.parse(readFileSync(cache, 'utf8'));
  const before = await processorWatermark('user_transaction_processor');
  const started = new Date().toISOString();
  const senders = new Set<string>();
  let pages = 0, transactions = 0;
  for (const f of FUNCTIONS) {
    let after = 0;
    for (;;) {
      const page = (await gql(QUERY, { c: ARIES, m: 'controller', f, after }, 'senders')).user_transactions;
      pages++; transactions += page.length;
      page.forEach((t: any) => senders.add(normalize(t.sender)));
      if (page.length < 100) break;
      after = page[page.length - 1].version;
    }
  }
  const report = { functions: FUNCTIONS.map(f => `${ARIES}::controller::${f}`), pages, transactions, enumerationStart: started,
    enumerationEnd: new Date().toISOString(), processor: 'user_transaction_processor', watermarkBefore: before,
    watermarkAfter: await processorWatermark('user_transaction_processor'),
    scope: 'senders of aries controller::register_user[_with_referrer] entry calls; contract-registered users excluded' };
  const result = { senders: [...senders], report };
  writeJson(cache, result);
  return result;
}

// Mulberry32: small seeded PRNG so the sample is reproducible from the recorded seed.
function shuffle<T>(items: T[], seed: number): T[] {
  let s = seed >>> 0;
  const rand = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

async function call(url: string, init: RequestInit = {}): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(60_000) });
    stats.requests++;
    if (res.status === 404) return null;
    if ((res.status === 429 || res.status >= 500) && attempt < 5) { stats.retries++; await new Promise(r => setTimeout(r, 2000 * 2 ** attempt)); continue; }
    const body = await res.json();
    if (!res.ok) throw Object.assign(new Error(`${res.status} ${JSON.stringify(body).slice(0, 200)}`), { body });
    return body;
  }
}
const resourceAt = (base: string, address: string, type: string, version: string) =>
  call(`${base}/accounts/${address}/resource/${encodeURIComponent(type)}?ledger_version=${version}`);
const viewAt = (base: string, fn: string, args: unknown[], typeArgs: string[], version: string) =>
  call(`${base}/view?ledger_version=${version}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ function: fn, type_arguments: typeArgs, arguments: args }) });

const text = (v: string) => v.startsWith('0x') ? Buffer.from(v.slice(2), 'hex').toString('utf8') : v;
const tag = (info: any) => `${normalize(info.account_address)}::${text(info.module_name)}::${text(info.struct_name)}`;
const option = (v: any) => v?.vec?.[0] ?? null;

// Follow Profile.deposited_reserves from head to tail; only keys are needed (amounts come from the view).
async function reserveKeys(table: any, version: string): Promise<string[]> {
  const handle = table.inner.inner.handle, length = Number(table.inner.length);
  let key = option(table.head);
  const tail = option(table.tail), out: string[] = [];
  for (let i = 0; i < length && key; i++) {
    out.push(tag(key));
    if (tag(key) === tag(tail)) break;
    const item = await call(`${FULLNODE}/tables/${handle}/item?ledger_version=${version}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key_type: TYPE_INFO, value_type: `${ARIES}::iterable_table::IterableValue<${TYPE_INFO}, ${ARIES}::profile::Deposit>`, key }) });
    key = option(item.next);
  }
  if (out.length !== length) throw new Error(`walked ${out.length} of ${length} reserves`);
  return out;
}

// Smallest version whose timestamp is >= target seconds, by binary search over archive transactions.
async function versionAt(targetSecs: number, hi: number): Promise<string> {
  let lo = 0;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const ts = Number((await archive(`/transactions/by_version/${mid}`)).timestamp) / 1e6;
    if (ts < targetSecs) lo = mid + 1; else hi = mid;
  }
  return String(lo);
}

async function main() {
  const log = startLog('05-aries');
  const t0 = Date.now();
  const { senders, report } = await enumerate();
  const enumMs = Date.now() - t0;
  const pinned = await ledger();
  const preDrain = await versionAt(DRAIN_START, Number(pinned.version));
  const sample = shuffle(senders as string[], SEED).slice(0, SAMPLE);

  // Asset pricing from the aptos-script catalog (identity-bound; unpriced stays unpriced).
  const catalog = JSON.parse(readFileSync(process.env.APTOS_SCRIPT_CATALOG ?? '../../tmp/aptos-script/app/catalog.json', 'utf8'));
  const assetOf = new Map<string, any>();
  for (const a of catalog.assets) for (const id of a.identifiers) assetOf.set(id.includes('::') ? id.replace(/^0x[0-9a-f]+/, m => normalize(m)) : normalize(id), a);
  const ids = [...new Set(catalog.assets.map((a: any) => a.coingeckoId).filter(Boolean))].join(',');
  const prices: any = await (await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_last_updated_at=true`)).json();

  const wrapper = new Map<string, string>();
  async function underlying(reserve: string): Promise<string> {
    if (!reserve.startsWith(ARIES)) return reserve;
    if (!wrapper.has(reserve)) {
      const info = await resourceAt(FULLNODE, ARIES, `${ARIES}::fa_to_coin_wrapper::WrapperCoinInfo<${reserve}>`, pinned.version);
      wrapper.set(reserve, info ? normalize(info.data.metadata.inner) : reserve);
    }
    return wrapper.get(reserve)!;
  }

  const t1 = Date.now();
  const rows = await mapLimit(sample, 8, async user => {
    try {
      const profiles = await resourceAt(FULLNODE, user, `${ARIES}::profile::Profiles`, pinned.version);
      if (!profiles) return { user, status: 'no_profiles' };
      const out: any[] = [];
      for (const row of profiles.data.profile_signers.data) {
        const name = text(row.key).replace(/^profile/, '');
        const address = normalize(row.value.account);
        const profile = await resourceAt(FULLNODE, address, `${ARIES}::profile::Profile`, pinned.version);
        if (!profile) continue;
        const hasDebt = Number(profile.data.borrowed_reserves.inner.length) > 0;
        for (const reserve of await reserveKeys(profile.data.deposited_reserves, pinned.version)) {
          const [lp, now] = (await viewAt(FULLNODE, `${ARIES}::profile::profile_deposit`, [user, name], [reserve], pinned.version)).map(BigInt);
          let face: bigint | null = null;
          try { face = BigInt((await viewAt(ARCHIVE, `${ARIES}::profile::profile_deposit`, [user, name], [reserve], preDrain))[1]); }
          catch { face = null; }   // profile or reserve created after the pre-drain version
          out.push({ profile: address, name, reserve, asset: await underlying(reserve), lp, now, face, hasDebt });
        }
      }
      return { user, status: 'ok', deposits: out };
    } catch (err) { return { user, status: 'error', error: String(err).slice(0, 200) }; }
  });
  const verifyMs = Date.now() - t1;

  const deposits = rows.flatMap((r: any) => (r.deposits ?? []).map((d: any) => ({ user: r.user, ...d })));
  const usd = (asset: string, raw: bigint | null) => {
    const a = assetOf.get(asset), p = a?.coingeckoId && prices[a.coingeckoId];
    return raw === null || !p ? null : Number(raw) / 10 ** a.decimals * p.usd;
  };
  const counted = deposits.filter((d: any) => !d.hasDebt && d.lp > 0n);
  const total = (field: 'now' | 'face') => {
    let priced = 0, unpriced = 0;
    for (const d of counted) { const v = usd(d.asset, d[field]); if (v === null) unpriced++; else priced += v; }
    return { usd: priced, unpricedDeposits: unpriced };
  };
  const summary = {
    source: 'aries-wound-down (blocked)', ledgerVersion: pinned.version, preDrainVersion: preDrain, preDrainTime: new Date(DRAIN_START * 1000).toISOString(),
    enumeration: { ...report, senders: senders.length, ms: enumMs },
    sample: { seed: SEED, size: sample.length, method: 'mulberry32 Fisher-Yates over senders in enumeration order' },
    verification: { ms: verifyMs, byStatus: Object.fromEntries(['ok', 'no_profiles', 'error'].map(s => [s, rows.filter((r: any) => r.status === s).length])),
      deposits: deposits.length, withDebt: deposits.filter((d: any) => d.hasDebt).length, debtFreeDeposits: counted.length,
      owners: new Set(counted.map((d: any) => d.user)).size, faceUnknown: counted.filter((d: any) => d.face === null).length,
      errors: rows.filter((r: any) => r.status === 'error').map((r: any) => ({ user: r.user, error: r.error })) },
    sampleTotals: { contractQuoteNow: total('now'), preDrainFace: total('face') },
    extrapolation: { factor: senders.length / sample.length, note: 'linear; heavy-tailed balances make this a rough indicator only' },
    byAsset: Object.fromEntries([...Map.groupBy(counted, (d: any) => d.asset)].map(([a, ds]) => [assetOf.get(a)?.symbol ?? a,
      { deposits: ds.length, nowRaw: ds.reduce((s: bigint, d: any) => s + d.now, 0n).toString(), faceRaw: ds.reduce((s: bigint, d: any) => s + (d.face ?? 0n), 0n).toString() }])),
    requests: stats, log,
  };
  writeJson(`${DIR}/deposits.json`, deposits);
  writeJson(`${DIR}/summary.json`, summary);
  console.log(JSON.stringify(summary, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));
}

await main();
