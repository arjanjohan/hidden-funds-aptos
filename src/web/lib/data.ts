import type { Snapshot, SnapshotSource } from '../../shared/snapshot.ts';
import { SOURCES } from '../../shared/sources/index.ts';

// Missing until the pipeline's first run; pages render an empty state instead of failing the build.
const files = import.meta.glob<Snapshot>('../../../snapshot/latest.json', { eager: true, import: 'default' });
export const snapshot: Snapshot | null = Object.values(files)[0] ?? null;

/** Weekly cadence plus one day of slack. */
export const STALE_AFTER_MS = 8 * 86_400_000;

const PROTOCOL = new Map(SOURCES.map(s => [s.id, s.protocol]));
/** The protocol a published source belongs to (several sources can share one). */
export const protocolOf = (s: SnapshotSource) => PROTOCOL.get(s.id) ?? s.title;

export type Slice = { label: string; usd: number };

/** Headline value (90+ days) per protocol, largest first. Slices under `minShare` of the total merge into "Other". */
export function byProtocol(sources: SnapshotSource[], minShare = 0.02): Slice[] {
  const sums = new Map<string, number>();
  for (const s of sources) sums.set(protocolOf(s), (sums.get(protocolOf(s)) ?? 0) + s.totals.headline.usd);
  const total = [...sums.values()].reduce((a, b) => a + b, 0);
  const all = [...sums].map(([label, usd]) => ({ label, usd })).filter(x => x.usd > 0).sort((a, b) => b.usd - a.usd);
  const kept = all.filter(x => x.usd >= total * minShare), rest = all.filter(x => x.usd < total * minShare);
  const other = rest.reduce((a, x) => a + x.usd, 0);
  return other > 0 ? [...kept, { label: rest.length === 1 ? rest[0].label : 'Other', usd: other }] : kept;
}
