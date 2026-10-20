import { afterEach, describe, expect, it, vi } from 'vitest';
import { readers, RequestCapReached } from '../src/node/client.ts';
import { createReader, gqlAll } from '../src/shared/chain.ts';

afterEach(() => vi.unstubAllGlobals());

const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe('reader', () => {
  it('treats a missing resource as absent', async () => {
    vi.stubGlobal('fetch', async () => respond(404, { error_code: 'resource_not_found' }));
    expect(await createReader({ retries: 0 }).resource('0x1', '0x1::a::B', '5')).toBeNull();
  });

  it('retries a node that is behind the pinned version instead of calling the resource absent', async () => {
    const replies = [respond(404, { error_code: 'version_not_found' }), respond(200, { data: { ok: true } })];
    vi.stubGlobal('fetch', async () => replies.shift()!);
    vi.useFakeTimers();
    const pending = createReader({ retries: 2 }).resource('0x1', '0x1::a::B', '5');
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ ok: true });
    vi.useRealTimers();
  });

  it('reports a rate-limit wait before retrying', async () => {
    const replies = [respond(200, { errors: [{ message: 'Per anonymous IP rate limit exceeded', extensions: { code: '429' } }] }), respond(200, { data: { ok: true } })];
    vi.stubGlobal('fetch', async () => replies.shift()!);
    vi.useFakeTimers();
    const waits: [number, number][] = [];
    const pending = createReader({ retries: 2, onWait: (_l, ms, status) => waits.push([ms, status]) }).gql('{ x }');
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ ok: true });
    expect(waits).toEqual([[2_000, 429]]);
    vi.useRealTimers();
  });

  it('fails rather than answering absent when the node stays behind', async () => {
    vi.stubGlobal('fetch', async () => respond(404, { error_code: 'version_not_found' }));
    await expect(createReader({ retries: 0 }).resource('0x1', '0x1::a::B', '5')).rejects.toThrow(/404/);
  });
});

describe('request cap', () => {
  it('counts keyed Aptos requests only; Movement reads never hit the cap', async () => {
    vi.stubEnv('GEOMI_API_KEY', 'test');
    vi.stubGlobal('fetch', async () => respond(200, { data: { ok: true } }));
    const { chains, usage } = readers(1);
    await chains.aptos.resource('0x1', '0x1::a::B');
    await expect(chains.aptos.resource('0x1', '0x1::a::B')).rejects.toBeInstanceOf(RequestCapReached);
    for (let i = 0; i < 3; i++) await chains.movement.resource('0x1', '0x1::a::B');
    expect(usage.requests).toBe(1);
    vi.unstubAllEnvs();
  });
});

describe('gqlAll', () => {
  it('pages past the indexer\'s 100-row limit with the key of the last row', async () => {
    const afters: unknown[] = [];
    const chain = { gql: async (_q: string, v: Record<string, unknown>) => {
      afters.push(v.after);
      const start = v.after === '' ? 0 : Number(String(v.after).slice(1)) + 1;
      const n = Math.max(0, Math.min(100, 230 - start));
      return { rows: Array.from({ length: n }, (_, i) => ({ id: `k${String(start + i).padStart(3, '0')}` })) };
    } } as any;
    const rows = await gqlAll(chain, 'q', { o: 1 }, 'rows', 'id');
    expect(rows).toHaveLength(230);
    expect(afters).toEqual(['', 'k099', 'k199']);
  });
});

