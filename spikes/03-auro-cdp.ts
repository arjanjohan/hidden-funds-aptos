// Phase 0, shape 3: collection/object positions — Auro (Aptos) CDP NFTs. ENUMERATION EXPERIMENT ONLY, NOT COUNTED:
// zero debt does not satisfy R2 without closure evidence.
//
// Enumerate:  current_token_ownerships_v2 by collection_id, keyset-paged on token_data_id.
// Verify:     per position object at one pinned ledger: ObjectCore.owner (must match the indexer owner),
//             auro_pool::AuroPosition + lending_pool::UserPosition shares, pool State for share→amount.
//
// Usage: node --experimental-strip-types --no-warnings spikes/03-auro-cdp.ts [--fresh]
import { existsSync, readFileSync } from 'node:fs';
import { FULLNODE, gql, ledger, mapLimit, normalize, processorWatermark, startLog, stats, writeJson } from './lib.ts';

const AURO = '0x50a340a19e6ada1be07192c042786ca6a9651d5c845acc8727e8c6416a56a32c';
const COLLECTION = '0x0bc8b183a8bfbd127e2a7a53944c10fd7d22f34e20d336c9a85f375f552ef951';
const DIR = 'data/auro-cdp';
const FRESH = process.argv.includes('--fresh');
const KEY = readFileSync('.env', 'utf8').match(/^GEOMI_API_KEY=(.*)$/m)![1].trim();

const QUERY = `query($c:String!,$after:String!){
  current_token_ownerships_v2(where:{current_token_data:{collection_id:{_eq:$c}}, amount:{_gt:"0"}, token_data_id:{_gt:$after}},
    order_by:[{token_data_id:asc},{owner_address:asc}], limit:100){ token_data_id owner_address amount last_transaction_version } }`;

async function enumerate() {
  const cache = `${DIR}/tokens.json`;
  if (!FRESH && existsSync(cache)) return JSON.parse(readFileSync(cache, 'utf8'));
  const before = await processorWatermark('token_v2_processor');
  const started = new Date().toISOString();
  const rows: any[] = [];
  let after = '', pages = 0;
  for (;;) {
    const page = (await gql(QUERY, { c: COLLECTION, after }, 'tokens')).current_token_ownerships_v2;
    pages++; rows.push(...page);
    if (page.length < 100) break;
    after = page[page.length - 1].token_data_id;
  }
  const report = { query: QUERY, pages, rows: rows.length, enumerationStart: started, enumerationEnd: new Date().toISOString(),
    processor: 'token_v2_processor', watermarkBefore: before, watermarkAfter: await processorWatermark('token_v2_processor'),
    scope: `current_token_ownerships_v2 rows with amount>0 in collection ${COLLECTION}` };
  writeJson(cache, { rows, report });
  return { rows, report };
}

async function resources(address: string, version: string): Promise<any[] | null> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${FULLNODE}/accounts/${address}/resources?ledger_version=${version}&limit=100`, { headers: { authorization: `Bearer ${KEY}` } });
    stats.requests++;
    if (res.status === 404) return null;
    if ((res.status === 429 || res.status >= 500) && attempt < 5) { stats.retries++; await new Promise(r => setTimeout(r, 2000 * 2 ** attempt)); continue; }
    if (!res.ok) throw new Error(`resources ${address}: ${res.status}`);
    return res.json();
  }
}
const find = (rs: any[], type: string) => rs.find(r => r.type === type)?.data;

async function main() {
  const log = startLog('03-auro-cdp');
  const t0 = Date.now();
  const { rows, report } = await enumerate();
  const enumMs = Date.now() - t0;
  const pinned = await ledger();
  const t1 = Date.now();

  const pools = new Map<string, any>();
  async function pool(address: string) {
    if (!pools.has(address)) {
      const rs = (await resources(address, pinned.version))!;
      pools.set(address, { state: find(rs, `${AURO}::lending_pool::State`), pool: find(rs, `${AURO}::lending_pool::LendingPool`) });
    }
    return pools.get(address);
  }

  const results = await mapLimit(rows, 8, async (row: any) => {
    const object = normalize(row.token_data_id);
    try {
      const rs = await resources(object, pinned.version);
      if (!rs) return { object, status: 'deleted' };
      const owner = normalize(find(rs, '0x1::object::ObjectCore').owner);
      const position = find(rs, `${AURO}::lending_pool::UserPosition`);
      if (!find(rs, `${AURO}::auro_pool::AuroPosition`) || !position) return { object, owner, status: 'not_a_position' };
      const debts = position.debt_shares.data.filter((d: any) => BigInt(d.value) > 0n);
      const deposits = [];
      for (const d of position.deposit_shares.data.filter((x: any) => BigInt(x.value) > 0n)) {
        const p = await pool(normalize(d.key.inner));
        const supply = BigInt(p.state.total_reserves_amount) + BigInt(p.state.total_debt_amount) - BigInt(p.state.total_fees);
        deposits.push({ pool: normalize(d.key.inner), token: p.pool.token, amount: BigInt(d.value) * supply / BigInt(p.state.total_supply_shares),
          reserves: BigInt(p.state.total_reserves_amount), paused: p.state.is_paused });
      }
      return { object, owner, indexerOwner: normalize(row.owner_address), ownerMatches: owner === normalize(row.owner_address),
        hasDebt: debts.length > 0, deposits, status: 'ok' };
    } catch (err) { return { object, status: 'error', error: String(err).slice(0, 200) }; }
  });
  const verifyMs = Date.now() - t1;

  const ok = results.filter((r: any) => r.status === 'ok');
  const debtFree = ok.filter((r: any) => !r.hasDebt && r.deposits.length);
  const byToken = new Map<string, { positions: number; raw: bigint }>();
  for (const r of debtFree) for (const d of r.deposits) {
    const t = byToken.get(d.token) ?? { positions: 0, raw: 0n };
    t.positions++; t.raw += d.amount; byToken.set(d.token, t);
  }
  const summary = {
    source: 'auro-cdp (experiment, not counted)', ledgerVersion: pinned.version,
    enumeration: { ...report, query: undefined, ms: enumMs },
    verification: { ms: verifyMs, objects: rows.length,
      byStatus: Object.fromEntries(['ok', 'deleted', 'not_a_position', 'error'].map(s => [s, results.filter((r: any) => r.status === s).length])),
      ownerMismatches: ok.filter((r: any) => !r.ownerMatches).length, withDebt: ok.filter((r: any) => r.hasDebt).length,
      debtFreeWithDeposits: debtFree.length, owners: new Set(debtFree.map((r: any) => r.owner)).size },
    debtFreeByToken: Object.fromEntries([...byToken].map(([t, v]) => [t, { positions: v.positions, raw: v.raw.toString() }])),
    pools: Object.fromEntries([...pools].map(([a, p]) => [a, { token: p.pool?.token, paused: p.state?.is_paused, reserves: p.state?.total_reserves_amount }])),
    requests: stats, log,
  };
  writeJson(`${DIR}/positions.json`, results);
  writeJson(`${DIR}/summary.json`, summary);
  console.log(JSON.stringify(summary, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));
}

await main();
