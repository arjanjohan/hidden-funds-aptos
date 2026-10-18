// Published snapshot format: aggregates only, never owner addresses.
import type { PriceBook, SourceTotals } from './accounting.ts';
import type { SourceDef } from './types.ts';

export interface Sanity { check: string; ok: boolean | null; detail: string }

export interface SourceRun {
  processor: string;
  scope: string;
  watermarkBefore?: { version: string; timestamp: string };
  watermarkAfter?: { version: string; timestamp: string };
  enumeration: { start?: string; end?: string; pages: number; newCandidates: number; candidates: number; cursor?: string };
  verification: { start?: string; end?: string; ledgerFrom?: string; ledgerTo?: string; read: number; incomplete: number; notReread: number };
  sanity?: Sanity;
  completeness: 'complete' | 'degraded';
  degradedReasons: string[];
  errors: string[];
}

export interface SnapshotSource {
  id: string; title: string; summary: string; category: string; inclusionRule: string;
  protocolStatus: SourceDef['protocolStatus']; howTo: string[]; officialUrl?: string; headlineAgeBases: string[];
  run: SourceRun;
  lastSuccessAt?: string;
  totals: SourceTotals;
  /** Recoverable positions by expected payout (USD) band: < 1, 1–10, …, ≥ 10k. */
  sizeBands: { upTo: number | null; positions: number }[];
}

export interface Snapshot {
  schema: 1;
  generatedAt: string;
  prices: PriceBook;
  priceErrors: string[];
  sources: SnapshotSource[];
  global: { headlineUsd: number; headlineOwners: number; headlineOwnersMin10: number; recoverableUsd: number; requests: number; requestCap: number };
}

