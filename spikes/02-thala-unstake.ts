// Phase 0, shape 2: history by entry function — Thala matured APT unstake requests never completed.
//
// Enumerate:  senders of <thala>::scripts::request_unstake_APT from user_transactions, version-cursor paged.
//             The composite filter (contract, module, function) is indexed; entry_function_id_str alone times out.
// Verify:     <thala>::staking::user_unstake(account) at one pinned ledger version → UnstakeRequest{request_id, end_sec, amount}.
// Age:        end_sec (on-chain maturity).
// Scope gap:  requests created by other contracts calling staking::request_unstake_APT are not enumerated; the sum of
//             found requests is compared with TLSD.apt_pending_withdrawal to measure that gap.
//
// Usage: node --experimental-strip-types --no-warnings spikes/02-thala-unstake.ts [--fresh]
import { existsSync, readFileSync } from 'node:fs';
import { aptUsd, gql, ledger, mapLimit, normalize, processorWatermark, resource, startLog, stats, view, writeJson } from './lib.ts';

const THALA = '0xfaf4e633ae9eb31366c9ca24214231760926576c7b625313b3688b5e900731f6';
const DIR = 'data/thala-unstake';
const FRESH = process.argv.includes('--fresh');
const DAY = 86_400;

const SENDERS_QUERY = `query($c:String!,$m:String!,$f:String!,$after:bigint!){
  user_transactions(where:{entry_function_contract_address:{_eq:$c}, entry_function_module_name:{_eq:$m},
    entry_function_function_name:{_eq:$f}, version:{_gt:$after}}, order_by:{version:asc}, limit:100){ version sender timestamp } }`;

async function enumerate() {
  const cache = `${DIR}/senders.json`;
  if (!FRESH && existsSync(cache)) return JSON.parse(readFileSync(cache, 'utf8'));
  const before = await processorWatermark('user_transaction_processor');
  const started = new Date().toISOString();
  const txs: { version: number; sender: string; timestamp: string }[] = [];
  let after = 0, pages = 0;
  for (;;) {
    const page = (await gql(SENDERS_QUERY, { c: THALA, m: 'scripts', f: 'request_unstake_APT', after }, 'senders')).user_transactions;
    pages++;
    txs.push(...page);
    if (page.length < 100) break;
    after = page[page.length - 1].version;
  }
  const report = { query: SENDERS_QUERY, function: `${THALA}::scripts::request_unstake_APT`, pageSize: 100, pages, transactions: txs.length,
    firstVersion: txs[0]?.version, lastVersion: txs.at(-1)?.version, enumerationStart: started, enumerationEnd: new Date().toISOString(),
    processor: 'user_transaction_processor', watermarkBefore: before, watermarkAfter: await processorWatermark('user_transaction_processor'),
    scope: 'senders of thala scripts::request_unstake_APT entry calls; composed calls from other contracts excluded' };
  const result = { senders: [...new Set(txs.map(t => normalize(t.sender)))], report };
  writeJson(cache, result);
  return result;
}

async function main() {
  const log = startLog('02-thala-unstake');
  const t0 = Date.now();
  const { senders, report } = await enumerate();
  const enumMs = Date.now() - t0;

  const pinned = await ledger();
  const nowSecs = Number(BigInt(pinned.timestampUs) / 1_000_000n);
  const tlsd = (await resource(THALA, `${THALA}::staking::TLSD`, pinned.version)).data;
  const paused = (await resource(THALA, `${THALA}::staking::PauseFlag`, pinned.version)).data.paused;
  const verifyStart = new Date().toISOString();
  const t1 = Date.now();
  const reads = await mapLimit(senders as string[], 8, async account => {
    try { return { account, requests: (await view(`${THALA}::staking::user_unstake`, [account], [], pinned.version))[0] }; }
    catch (err) { return { account, error: String(err).slice(0, 200) }; }
  });
  const verifyMs = Date.now() - t1;

  const requests = reads.flatMap((r: any) => (r.requests ?? []).map((q: any) => ({
    owner: normalize(q.account), requestId: q.request_id, startSec: Number(q.start_sec), endSec: Number(q.end_sec), amount: BigInt(q.amount),
  })));
  const matured = requests.filter(q => q.endSec <= nowSecs);
  const pending = requests.filter(q => q.endSec > nowSecs);

  const price = await aptUsd();
  const positions = matured.map(q => {
    const apt = Number(q.amount) / 1e8;
    return { id: `thala-unstake:${q.owner}:${q.requestId}:request`, owner: q.owner, requestId: q.requestId, apt, usd: apt * price.usd,
      claimableSince: q.endSec, ageBasis: 'onchain_maturity', ageDays: (nowSecs - q.endSec) / DAY,
      status: paused ? 'blocked' : 'recoverable', blockers: paused ? [{ code: 'paused', detail: 'Thala staking PauseFlag set' }] : [] };
  });

  const sum = (ps: any[]) => ({ positions: ps.length, owners: new Set(ps.map(p => p.owner)).size, apt: ps.reduce((a, p) => a + p.apt, 0), usd: ps.reduce((a, p) => a + p.usd, 0) });
  const aged = (days: number) => sum(positions.filter(p => p.ageDays >= days));
  const rawSum = (qs: any[]) => qs.reduce((a, q) => a + q.amount, 0n);

  const summary = {
    source: 'thala-unstake-unclaimed',
    ledgerVersion: pinned.version, ledgerTime: new Date(nowSecs * 1000).toISOString(),
    enumeration: { ...report, query: undefined, senders: senders.length, ms: enumMs },
    verification: { start: verifyStart, end: new Date().toISOString(), ms: verifyMs, accounts: senders.length,
      errors: reads.filter((r: any) => r.error).length, accountsWithRequests: reads.filter((r: any) => r.requests?.length).length,
      requests: requests.length, matured: matured.length, pending: pending.length },
    protocol: { paused, nextUnstakeRequestId: tlsd.next_unstake_request_id, unstakeDurationSeconds: tlsd.unstake_duration_seconds },
    price: { source: 'coingecko simple/price', usd: price.usd, at: new Date(price.at * 1000).toISOString() },
    totals: { recoverableNow: sum(positions), ownersWithAtLeast10Usd: new Set(positions.filter(p => p.usd >= 10).map(p => p.owner)).size,
      aged: { ge30: aged(30), ge90: aged(90), ge180: aged(180) }, pendingNotMatured: { requests: pending.length, apt: Number(rawSum(pending)) / 1e8 } },
    sanity: {
      check: 'sum of all open requests found vs TLSD.apt_pending_withdrawal (APT already withdrawn from pools, held for claims)',
      foundMaturedApt: Number(rawSum(matured)) / 1e8, foundAllApt: Number(rawSum(requests)) / 1e8,
      aptPendingWithdrawal: Number(tlsd.apt_pending_withdrawal.value) / 1e8, thAPTUnstaking: Number(tlsd.thAPT_unstaking.value) / 1e8,
    },
    requests: stats, log,
    top: positions.sort((a, b) => b.usd - a.usd).slice(0, 15).map(p => ({ owner: p.owner, requestId: p.requestId, apt: p.apt, ageDays: Math.round(p.ageDays) })),
  };
  writeJson(`${DIR}/positions.json`, positions);
  writeJson(`${DIR}/summary.json`, summary);
  console.log(JSON.stringify(summary, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));
}

await main();
