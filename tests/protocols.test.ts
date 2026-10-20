import { describe, expect, it } from 'vitest';
import { PROTOCOLS } from '../src/shared/protocols.ts';
import { SOURCES } from '../src/shared/sources/index.ts';

describe('protocol registry', () => {
  it('lists every source under exactly one implemented or dormant protocol, and only sources that exist', () => {
    const listed = PROTOCOLS.flatMap(p => p.sources ?? []);
    expect([...listed].sort()).toEqual(SOURCES.map(s => s.id).sort());
  });

  it('gives each entry what its status needs', () => {
    const ids = PROTOCOLS.map(p => p.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    for (const p of PROTOCOLS) {
      const withSources = p.status === 'implemented' || p.status === 'dormant';
      expect({ id: p.id, sources: (p.sources?.length ?? 0) > 0 }).toEqual({ id: p.id, sources: withSources });
      if (p.status === 'needs_decision') expect({ id: p.id, issue: typeof p.issue }).toEqual({ id: p.id, issue: 'number' });
      // A checked status says when; "not checked" does not pretend to.
      expect({ id: p.id, dated: /^\d{4}-\d{2}-\d{2}$/.test(p.checkedAt ?? '') }).toEqual({ id: p.id, dated: p.status !== 'not_checked' });
      expect(p.reason.length).toBeGreaterThan(0);
      expect(p.chains.length).toBeGreaterThan(0);
    }
  });
});
