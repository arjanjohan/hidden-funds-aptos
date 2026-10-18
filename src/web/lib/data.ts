import type { Snapshot } from '../../shared/snapshot.ts';

// Missing until the pipeline's first run; pages render an empty state instead of failing the build.
const files = import.meta.glob<Snapshot>('../../../snapshot/latest.json', { eager: true, import: 'default' });
export const snapshot: Snapshot | null = Object.values(files)[0] ?? null;

/** Weekly cadence plus one day of slack. */
export const STALE_AFTER_MS = 8 * 86_400_000;
