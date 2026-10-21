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

  // The check page sends a visitor's own key (`Bearer ${key}`, from their input); a key written into the bundle is a
  // literal token after "Bearer", and the pipeline's own key, where this machine has it, must appear nowhere.
  it.runIf(existsSync('dist'))('the built site contains no key or node-only code', () => {
    const own = [process.env.GEOMI_API_KEY, process.env.GEOMI_API_KEY_FALLBACK,
      ...(existsSync('.env') ? readFileSync('.env', 'utf8').split('\n').filter(l => l.startsWith('GEOMI_API_KEY')).map(l => l.slice(l.indexOf('=') + 1).trim()) : [])]
      .filter((k): k is string => !!k && k.length >= 16);
    const offenders = files('dist').filter(f => /\.(js|html)$/.test(f)).filter(f => {
      const text = readFileSync(f, 'utf8');
      return /GEOMI|Bearer\s+[A-Za-z0-9_-]{16,}|node:sqlite|src\/node\//.test(text) || own.some(k => text.includes(k));
    });
    expect(offenders).toEqual([]);
  });
});
