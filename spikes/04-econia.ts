// Phase 0, shape 4: account resource on a user account — Econia market accounts. ENUMERATION EXPERIMENT ONLY,
// NOT COUNTED: no closure evidence yet; zero open orders alone does not satisfy R2.
//
// Enumerate:  senders of user::register_market_account and user::register_market_account_generic_base
//             (user_transactions, composite filter, version cursor). Accounts registered by other contracts
//             (Kana, Fliq) are out of this scope.
// Verify:     user::get_market_accounts(address) at one pinned ledger version.
//
// Usage: node --experimental-strip-types --no-warnings spikes/04-econia.ts [--fresh]
import { existsSync, readFileSync } from 'node:fs';
import { gql, ledger, mapLimit, normalize, processorWatermark, startLog, stats, view, writeJson } from './lib.ts';

const ECONIA = '0xc0deb00c405f84c85dc13442e305df75d1288100cdd82675695f6148c7ece51c';
const FUNCTIONS = ['register_market_account', 'register_market_account_generic_base'];
const DIR = 'data/econia';
const FRESH = process.argv.includes('--fresh');

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
      const page = (await gql(QUERY, { c: ECONIA, m: 'user', f, after }, 'senders')).user_transactions;
      pages++; transactions += page.length;
      page.forEach((t: any) => senders.add(normalize(t.sender)));
      if (page.length < 100) break;
      after = page[page.length - 1].version;
    }
  }
  const report = { query: QUERY, functions: FUNCTIONS.map(f => `${ECONIA}::user::${f}`), pages, transactions,
    enumerationStart: started, enumerationEnd: new Date().toISOString(), processor: 'user_transaction_processor',
    watermarkBefore: before, watermarkAfter: await processorWatermark('user_transaction_processor'),
    scope: 'senders of econia user::register_market_account[_generic_base] entry calls; contract-registered accounts excluded' };
  const result = { senders: [...senders], report };
  writeJson(cache, result);
  return result;
}

async function main() {
  const log = startLog('04-econia');
  const t0 = Date.now();
  const { senders, report } = await enumerate();
  const enumMs = Date.now() - t0;
  const pinned = await ledger();
  const t1 = Date.now();
  const reads = await mapLimit(senders as string[], 8, async address => {
    try { return { address, accounts: (await view(`${ECONIA}::user::get_market_accounts`, [address], [], pinned.version))[0] }; }
    catch (err) { return { address, error: String(err).slice(0, 200) }; }
  });
  const verifyMs = Date.now() - t1;

  const accounts = reads.flatMap((r: any) => (r.accounts ?? []).map((a: any) => ({ owner: r.address, ...a })));
  const funded = accounts.filter((a: any) => BigInt(a.base_total) > 0n || BigInt(a.quote_total) > 0n);
  const withOrders = funded.filter((a: any) => a.asks.length || a.bids.length);
  const idle = funded.filter((a: any) => !a.asks.length && !a.bids.length);
  const byMarket = new Map<string, { accounts: number; base: bigint; quote: bigint }>();
  for (const a of idle) {
    const m = byMarket.get(a.market_id) ?? { accounts: 0, base: 0n, quote: 0n };
    m.accounts++; m.base += BigInt(a.base_available); m.quote += BigInt(a.quote_available); byMarket.set(a.market_id, m);
  }
  const summary = {
    source: 'econia-market-accounts (experiment, not counted)', ledgerVersion: pinned.version,
    enumeration: { ...report, query: undefined, senders: senders.length, ms: enumMs },
    verification: { ms: verifyMs, addresses: senders.length, errors: reads.filter((r: any) => r.error).length,
      marketAccounts: accounts.length, funded: funded.length, fundedWithOpenOrders: withOrders.length,
      idleFunded: idle.length, idleOwners: new Set(idle.map((a: any) => a.owner)).size,
      custodianAccounts: funded.filter((a: any) => a.custodian_id !== '0').length },
    idleByMarket: Object.fromEntries([...byMarket].sort((a, b) => b[1].accounts - a[1].accounts)
      .map(([m, v]) => [m, { accounts: v.accounts, baseAvailableRaw: v.base.toString(), quoteAvailableRaw: v.quote.toString() }])),
    requests: stats, log,
  };
  writeJson(`${DIR}/accounts.json`, accounts);
  writeJson(`${DIR}/summary.json`, summary);
  console.log(JSON.stringify(summary, null, 2));
}

await main();
