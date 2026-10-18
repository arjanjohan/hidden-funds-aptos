// Sample simulation of step 1 (delegation_pool::unlock) for the inactive-validator source; never signs.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { AccountAddress, Aptos, AptosConfig, Network } from '@aptos-labs/ts-sdk';
const KEY = readFileSync('.env', 'utf8').match(/^GEOMI_API_KEY=(.*)$/m)![1].trim();
const aptos = new Aptos(new AptosConfig({ network: Network.MAINNET, clientConfig: { API_KEY: KEY } }));
const db = new DatabaseSync(process.argv[2]);
const ps = (db.prepare("select json from positions where source='delegation-inactive-validator'").all() as any[]).map(r => JSON.parse(r.json)).filter(p => p.status === 'recoverable');
let s = 20261018 >>> 0;
const rand = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const sorted = ps.sort((a, b) => Number(BigInt(a.grossClaim[0].raw) - BigInt(b.grossClaim[0].raw)));
const pick = new Map<string, any>();
for (const i of [0, Math.floor(sorted.length / 2), sorted.length - 1]) pick.set(sorted[i].id, sorted[i]);
const rest = sorted.filter(p => !pick.has(p.id));
while (pick.size < 10) { const [p] = rest.splice(Math.floor(rand() * rest.length), 1); pick.set(p.id, p); }
let ok = 0, exact = 0, gas = 0;
for (const p of pick.values()) {
  const [pool, amount] = p.steps[0].arguments;
  const run = async (feePayer: boolean) => {
    const tx = await aptos.transaction.build.simple({ sender: p.owner, withFeePayer: feePayer, options: feePayer ? { maxGasAmount: 20000 } : undefined,
      data: { function: '0x1::delegation_pool::unlock', functionArguments: [pool, BigInt(amount)] } });
    if (feePayer) tx.feePayerAddress = AccountAddress.ZERO;
    const [r] = await aptos.transaction.simulate.simple({ transaction: tx, options: feePayer ? { estimateGasUnitPrice: true } : { estimateGasUnitPrice: true, estimateMaxGasAmount: true } });
    return r;
  };
  let r = await run(false), needsGas = false;
  if (!r.success && /INSUFFICIENT_BALANCE|Out of gas/.test(r.vm_status)) { needsGas = true; r = await run(true); }
  const ev = r.events.find((e: any) => e.type === '0x1::delegation_pool::UnlockStake');
  const unlocked = ev ? BigInt(ev.data.amount_unlocked) : 0n;
  // Shares round down when converted back to coins, so allow a few octas.
  const match = ev && BigInt(amount) - unlocked <= 10n && unlocked <= BigInt(amount);
  ok += r.success ? 1 : 0; exact += match ? 1 : 0; gas += needsGas ? 1 : 0;
  console.log(r.success ? 'ok ' : 'ERR', match ? 'exact' : 'diff', needsGas ? 'gas' : '   ', (Number(amount) / 1e8).toFixed(2), 'APT', 'unlocked', ev ? (Number(unlocked) / 1e8).toFixed(2) : '-', r.success ? '' : r.vm_status.slice(0, 120));
}
console.log(`sample ${pick.size}: simulated ok ${ok}, unlock amount exact ${exact}, owner needs gas ${gas} (seed 20261018)`);
