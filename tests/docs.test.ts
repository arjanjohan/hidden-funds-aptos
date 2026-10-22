import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// docs/left-behind.md and docs/sources.md are rendered as site pages (/how-we-count, /sources), where a relative link
// (another .md file) would break: links must be absolute URLs or in-page anchors.
describe('docs rendered on the site', () => {
  for (const file of ['docs/left-behind.md', 'docs/sources.md']) {
    it(`${file} has no relative links`, () => {
      const links = [...readFileSync(file, 'utf8').matchAll(/\]\(([^)]+)\)/g)].map(m => m[1]);
      expect(links.filter(l => !/^(https?:|mailto:|#)/.test(l))).toEqual([]);
    });
  }
});
