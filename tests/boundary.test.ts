// Layer boundary: browser-bound code (src/shared, src/web) must never reach node-only code, the environment or the key.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const FORBIDDEN = [/from ['"]node:/, /from ['"][^'"]*\/node\//, /process\.env/, /GEOMI/, /import\(['"]node:/];

describe('layer boundary', () => {
  for (const dir of ['src/shared', 'src/web']) {
    it(`${dir} imports nothing node-only`, () => {
      const offenders = files(dir).filter(f => /\.(ts|tsx|astro)$/.test(f))
        .flatMap(f => FORBIDDEN.filter(re => re.test(readFileSync(f, 'utf8'))).map(re => `${f}: ${re}`));
      expect(offenders).toEqual([]);
    });
  }

  it.runIf(existsSync('dist'))('the built site contains no key or node-only code', () => {
    const offenders = files('dist').filter(f => /\.(js|html)$/.test(f))
      .filter(f => /GEOMI|authorization:\s*`?Bearer|node:sqlite|src\/node\//.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
