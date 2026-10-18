// Sample simulation rate for any source, from pipeline state. Unsigned; never signs or submits.
//
// Payload: the position's first recovery step. Payout check: APT deposited into the owner's primary APT store
// (address derived from owner + metadata), compared with expectedPayout. Gas-only failures are re-run with a
// zero-address fee payer so "the contract pays" and "the owner can pay gas" are reported separately.
//
// Usage: node spikes/07-simulate-state.ts --state path --source id [--seed S] [--extra N]
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { AccountAddress, Aptos, AptosConfig, Network } from '@aptos-labs/ts-sdk';
import { normalizeAddress } from '../src/shared/chain.ts';
import { APT } from '../src/shared/sources/delegation.ts';
import type { Position } from '../src/shared/types.ts';

const args = process.argv.slice(2);
const opt = (name: string, fallback?: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const STATE = opt('--state')!, SOURCE = opt('--source')!;
const SEED = Number(opt('--seed', '20261018')), EXTRA = Number(opt('--extra', '7'));
const KEY = readFileSync('.env', 'utf8').match(/^GEOMI_API_KEY=(.*)$/m)![1].trim();
const aptos = new Aptos(new AptosConfig({ network: Network.MAINNET, clientConfig: { API_KEY: KEY } }));

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function primaryStore(owner: string, metadata: string): string {
  const bytes = (a: string) => Buffer.from(a.slice(2).padStart(64, '0'), 'hex');
  return '0x' + createHash('sha3-256').update(Buffer.concat([bytes(owner), bytes(metadata), Buffer.from([0xfc])])).digest('hex');
}

// Sources pay one asset per position; the check follows that asset.
const payout = (p: Position) => p.expectedPayout[0] ?? { asset: APT, raw: '0' };
const raw = (p: Position) => BigInt(payout(p).raw);

// FA metadata address for an asset id: itself for an FA, the paired metadata for a Coin type.
const metadataCache = new Map<string, string>();
async function metadataOf(asset: string): Promise<string> {
  if (!asset.includes('::')) return normalizeAddress(asset);
  if (!metadataCache.has(asset)) {
    const [m] = await aptos.view({ payload: { function: '0x1::coin::paired_metadata', typeArguments: [asset], functionArguments: [] } }) as any[];
    metadataCache.set(asset, normalizeAddress(m.vec[0].inner));
  }
  return metadataCache.get(asset)!;
}

function stratified(positions: Position[], rand: () => number): Position[] {
  const sorted = [...positions].sort((a, b) => (raw(a) < raw(b) ? -1 : raw(a) > raw(b) ? 1 : 0));
  const picked = new Map<string, Position>();
  for (const i of [0, Math.floor(sorted.length / 2), sorted.length - 1]) if (sorted[i]) picked.set(sorted[i].id, sorted[i]);
  const rest = sorted.filter(p => !picked.has(p.id));
  for (let n = 0; n < EXTRA && rest.length; n++) { const [p] = rest.splice(Math.floor(rand() * rest.length), 1); picked.set(p.id, p); }
  return [...picked.values()];
}

// Step arguments are display strings; "[a,b]" is a vector.
const parseArg = (a: string) => (a.startsWith('[') ? a.slice(1, -1).split(',').filter(Boolean) : a);

async function simulate(p: Position, feePayer: boolean) {
  const step = p.steps[0];
  // "addr::module::fn<T1, T2>" carries type arguments in the step's function string.
  const [fn, typeList] = step.function.match(/^([^<]+)(?:<(.*)>)?$/)!.slice(1);
  const transaction = await aptos.transaction.build.simple({ sender: p.owner, withFeePayer: feePayer, options: feePayer ? { maxGasAmount: 20_000 } : undefined,
    data: { function: fn as `${string}::${string}::${string}`, typeArguments: typeList ? typeList.split(',').map(t => t.trim()) : [],
      functionArguments: step.arguments.map(parseArg) } });
  if (feePayer) transaction.feePayerAddress = AccountAddress.ZERO;
  const [r] = await aptos.transaction.simulate.simple({ transaction, options: feePayer ? { estimateGasUnitPrice: true } : { estimateGasUnitPrice: true, estimateMaxGasAmount: true } });
  const asset = payout(p).asset;
  const store = primaryStore(p.owner, await metadataOf(asset));
  // Paid either into the owner's primary FA store, or (unmigrated Coin) into its CoinStore.
  const paid = r.events.filter((e: any) =>
      (e.type === '0x1::fungible_asset::Deposit' && normalizeAddress(e.data.store) === store) ||
      (e.type === '0x1::coin::CoinDeposit' && normalizeAddress(e.data.account) === p.owner && e.data.coin_type === asset))
    .reduce((s: bigint, e: any) => s + BigInt(e.data.amount), 0n);
  return { success: r.success, vmStatus: r.vm_status, paid };
}

const db = new DatabaseSync(STATE);
const positions = (db.prepare('select json from positions where source = ?').all(SOURCE) as any[]).map(r => JSON.parse(r.json) as Position);
const variants = Map.groupBy(positions, p => `${p.status}/${p.blockers.map(b => b.code).join('+') || '-'}/${p.steps[0]?.function ?? 'none'}`);
const rand = rng(SEED);
const report: Record<string, unknown> = {};
for (const [variant, group] of variants) {
  const sample = stratified(group, rand);
  const results = [];
  for (const p of sample) {
    try {
      let r = await simulate(p, false), needsGas = false;
      if (!r.success && /INSUFFICIENT_BALANCE|BALANCE_FOR_TRANSACTION_FEE|Out of gas/.test(r.vmStatus)) { needsGas = true; r = await simulate(p, true); }
      results.push({ id: p.id, expected: raw(p).toString(), paid: r.paid.toString(), success: r.success, payoutMatches: r.paid === raw(p), needsGas, vmStatus: r.vmStatus });
    } catch (err) { results.push({ id: p.id, success: false, error: String(err).slice(0, 200) }); }
  }
  report[variant] = { population: group.length, sampled: results.length, simulatedOk: results.filter(r => r.success).length,
    payoutMatches: results.filter((r: any) => r.payoutMatches).length, ownerNeedsGas: results.filter((r: any) => r.needsGas).length,
    failures: results.filter(r => !r.success), mismatches: results.filter((r: any) => r.success && !r.payoutMatches) };
}
console.log(JSON.stringify({ source: SOURCE, seed: SEED, extraPerStratum: EXTRA, note: 'Sample simulation rate, not a protocol-wide success rate.', variants: report }, null, 2));
