// Phase 0: sample simulation rate. Unsigned simulation of each source's recovery entry function on a deterministic
// stratified sample. Never signs or submits.
//
// Strata per source and variant: smallest, median and largest payout, plus EXTRA seeded picks.
// A simulation that fails only for gas (owner holds too little APT) is re-run with a zero-address fee payer so that
// "the contract pays out" and "the owner can pay gas" are reported separately.
//
// Usage: node --experimental-strip-types --no-warnings spikes/06-simulate.ts [--seed S] [--extra N]
import { readFileSync } from 'node:fs';
import { AccountAddress, Aptos, AptosConfig, Network } from '@aptos-labs/ts-sdk';
import { mapLimit, writeJson } from './lib.ts';

const args = process.argv.slice(2);
const arg = (name: string, fallback: number) => args.includes(name) ? Number(args[args.indexOf(name) + 1]) : fallback;
const SEED = arg('--seed', 20261018);
const EXTRA = arg('--extra', 7);
const KEY = readFileSync('.env', 'utf8').match(/^GEOMI_API_KEY=(.*)$/m)![1].trim();
const THALA = '0xfaf4e633ae9eb31366c9ca24214231760926576c7b625313b3688b5e900731f6';

const aptos = new Aptos(new AptosConfig({ network: Network.MAINNET, clientConfig: { API_KEY: KEY } }));

type Case = { source: string; variant: string; id: string; owner: string; expectedRaw: bigint; usd: number;
  payload: { function: `${string}::${string}::${string}`; functionArguments: any[] }; payoutEvent: string; payoutField: string };

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Smallest, median, largest, then EXTRA seeded picks from the rest.
function stratified(cases: Case[], rand: () => number): Case[] {
  const sorted = [...cases].sort((a, b) => (a.expectedRaw < b.expectedRaw ? -1 : a.expectedRaw > b.expectedRaw ? 1 : 0));
  const picked = new Map<string, Case>();
  for (const i of [0, Math.floor(sorted.length / 2), sorted.length - 1]) if (sorted[i]) picked.set(sorted[i].id, sorted[i]);
  const rest = sorted.filter(c => !picked.has(c.id));
  for (let n = 0; n < EXTRA && rest.length; n++) { const [c] = rest.splice(Math.floor(rand() * rest.length), 1); picked.set(c.id, c); }
  return [...picked.values()];
}

function delegationCases(): Case[] {
  const positions = JSON.parse(readFileSync('data/delegation/positions.json', 'utf8'));
  return positions.map((p: any) => ({
    source: 'native-delegation', variant: p.kind, id: `${p.delegator}:${p.pool}:${p.kind}`, owner: p.delegator,
    expectedRaw: BigInt(p.amount), usd: p.usd,
    payload: { function: '0x1::delegation_pool::withdraw', functionArguments: [p.pool, BigInt(p.amount)] },
    payoutEvent: '0x1::delegation_pool::WithdrawStake', payoutField: 'amount_withdrawn',
  }));
}

function thalaCases(): Case[] {
  const positions = JSON.parse(readFileSync('data/thala-unstake/positions.json', 'utf8'));
  return positions.map((p: any) => ({
    source: 'thala-unstake', variant: 'matured_request', id: p.id, owner: p.owner,
    expectedRaw: BigInt(Math.round(p.apt * 1e8)), usd: p.usd,
    payload: { function: `${THALA}::scripts::complete_unstake_APT`, functionArguments: [BigInt(p.requestId)] },
    payoutEvent: `${THALA}::staking::CompleteUnstakeAPTEvent`, payoutField: 'unstaked_amount',
  }));
}

async function simulate(c: Case, feePayer: boolean) {
  // With a zero-address fee payer the simulation skips the gas payment check; max gas is fixed because the
  // estimate is capped by a payer balance that does not exist.
  const transaction = await aptos.transaction.build.simple({ sender: c.owner, data: c.payload, withFeePayer: feePayer,
    options: feePayer ? { maxGasAmount: 20_000 } : undefined });
  if (feePayer) transaction.feePayerAddress = AccountAddress.ZERO;
  const [result] = await aptos.transaction.simulate.simple({ transaction,
    options: feePayer ? { estimateGasUnitPrice: true } : { estimateGasUnitPrice: true, estimateMaxGasAmount: true } });
  const event = result.events?.find((e: any) => e.type === c.payoutEvent);
  return { success: result.success, vmStatus: result.vm_status, gasUsed: result.gas_used, paidRaw: event ? String(event.data[c.payoutField]) : null };
}

async function main() {
  const rand = rng(SEED);
  const bySourceVariant = Map.groupBy([...delegationCases(), ...thalaCases()], c => `${c.source}/${c.variant}`);
  const sample = [...bySourceVariant.values()].flatMap(cases => stratified(cases, rand));
  const results = await mapLimit(sample, 4, async c => {
    try {
      let r = await simulate(c, false), gasOnly = false;
      if (!r.success && /INSUFFICIENT_BALANCE|BALANCE_FOR_TRANSACTION_FEE|Out of gas/.test(r.vmStatus)) {
        gasOnly = true;
        r = await simulate(c, true);
      }
      return { ...c, expectedRaw: c.expectedRaw.toString(), payload: undefined, ...r, ownerNeedsGas: gasOnly,
        payoutMatches: r.paidRaw !== null && BigInt(r.paidRaw) >= c.expectedRaw - 1n && BigInt(r.paidRaw) <= c.expectedRaw + 1n };
    } catch (err) { return { ...c, expectedRaw: c.expectedRaw.toString(), payload: undefined, success: false, error: String(err).slice(0, 300) }; }
  });
  const groups = Map.groupBy(results, (r: any) => `${r.source}/${r.variant}`);
  const summary = {
    seed: SEED, extraPerStratum: EXTRA, method: 'per source/variant: min, median, max payout + seeded picks (mulberry32)',
    note: 'Sample simulation rate, not a protocol-wide success rate.',
    bySourceVariant: Object.fromEntries([...groups].map(([k, rs]) => [k, {
      population: bySourceVariant.get(k)!.length, sampled: rs.length,
      simulatedOk: rs.filter((r: any) => r.success).length, payoutMatches: rs.filter((r: any) => r.payoutMatches).length,
      ownerNeedsGas: rs.filter((r: any) => r.ownerNeedsGas).length,
      failures: rs.filter((r: any) => !r.success).map((r: any) => ({ id: r.id, vmStatus: r.vmStatus, error: r.error })),
    }])),
    cases: results.map((r: any) => ({ id: r.id, source: r.source, variant: r.variant, expectedRaw: r.expectedRaw, paidRaw: r.paidRaw,
      success: r.success, ownerNeedsGas: r.ownerNeedsGas, vmStatus: r.vmStatus, gasUsed: r.gasUsed })),
  };
  writeJson('data/simulation/summary.json', summary);
  console.log(JSON.stringify({ ...summary, cases: undefined }, null, 2));
}

await main();
