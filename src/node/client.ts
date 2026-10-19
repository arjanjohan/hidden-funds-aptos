// Keyed chain access for the pipeline. Never imported by src/web or src/shared.
import { readFileSync } from 'node:fs';
import { createReader, type Network } from '../shared/chain.ts';
import type { ChainReader } from '../shared/types.ts';

function apiKey(): string {
  if (process.env.GEOMI_API_KEY) return process.env.GEOMI_API_KEY;
  try {
    const line = readFileSync('.env', 'utf8').split('\n').find(l => l.startsWith('GEOMI_API_KEY='));
    if (line) return line.slice('GEOMI_API_KEY='.length).trim();
  } catch { /* no local .env */ }
  throw new Error('Set GEOMI_API_KEY (environment or .env)');
}

export class RequestCapReached extends Error {}

/** `requests` counts keyed Aptos requests (the capped ones); `byLabel` counts every request. */
export interface Usage { requests: number; byLabel: Record<string, number> }

/** Readers for every network. `cap` bounds the keyed (paid) Aptos requests of a run: past it, Aptos reads throw
 *  RequestCapReached. Movement's public endpoints are free, get no credentials and never count. */
export function readers(cap: number, { anonymous = false } = {}): { chains: Record<Network, ChainReader>; usage: Usage } {
  const usage: Usage = { requests: 0, byLabel: {} };
  const count = (network: Network) => (label: string) => {
    if (network === 'aptos') {
      if (usage.requests >= cap) throw new RequestCapReached(`Request cap ${cap} reached`);
      usage.requests++;
    }
    const kind = `${network === 'aptos' ? '' : network + ' '}${label.split(' ')[0]}`;
    usage.byLabel[kind] = (usage.byLabel[kind] ?? 0) + 1;
  };
  return {
    chains: {
      // Anonymous (local runs without a key): Aptos Labs allows 40,000 compute units per 5 minutes per IP, and
      // parallel readers use up each new window between them, so a rate-limited request retries for up to ~1 hour.
      aptos: anonymous
        ? createReader({ network: 'aptos', onRequest: count('aptos'), retries: 60 })
        : createReader({ network: 'aptos', headers: { authorization: `Bearer ${apiKey()}` }, onRequest: count('aptos') }),
      movement: createReader({ network: 'movement', onRequest: count('movement') }),
    },
    usage,
  };
}

/** The keyed Aptos reader alone (spikes and probes). */
export function keyedReader(cap: number): { chain: ChainReader; usage: Usage } {
  const { chains, usage } = readers(cap);
  return { chain: chains.aptos, usage };
}

export async function processorWatermark(chain: ChainReader, processor: string) {
  const d = await chain.gql('query($p:String!){ processor_status(where:{processor:{_eq:$p}}){ last_success_version last_transaction_timestamp } }', { p: processor });
  const row = d.processor_status[0];
  if (!row) throw new Error(`Unknown indexer processor ${processor}`);
  return { version: String(row.last_success_version), timestamp: row.last_transaction_timestamp + 'Z' };
}
