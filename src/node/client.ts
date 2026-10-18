// Keyed chain access for the pipeline. Never imported by src/web or src/shared.
import { readFileSync } from 'node:fs';
import { createReader } from '../shared/chain.ts';
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

export interface Usage { requests: number; byLabel: Record<string, number> }

/** A keyed reader that counts requests and stops the run at `cap`. */
export function keyedReader(cap: number): { chain: ChainReader; usage: Usage } {
  const usage: Usage = { requests: 0, byLabel: {} };
  const chain = createReader({
    headers: { authorization: `Bearer ${apiKey()}` },
    onRequest(label) {
      if (usage.requests >= cap) throw new RequestCapReached(`Request cap ${cap} reached`);
      usage.requests++;
      const kind = label.split(' ')[0];
      usage.byLabel[kind] = (usage.byLabel[kind] ?? 0) + 1;
    },
  });
  return { chain, usage };
}

export async function processorWatermark(chain: ChainReader, processor: string) {
  const d = await chain.gql('query($p:String!){ processor_status(where:{processor:{_eq:$p}}){ last_success_version last_transaction_timestamp } }', { p: processor });
  const row = d.processor_status[0];
  if (!row) throw new Error(`Unknown indexer processor ${processor}`);
  return { version: String(row.last_success_version), timestamp: row.last_transaction_timestamp + 'Z' };
}
