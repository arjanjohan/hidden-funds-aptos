import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReader } from '../src/shared/chain.ts';

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

  it('fails rather than answering absent when the node stays behind', async () => {
    vi.stubGlobal('fetch', async () => respond(404, { error_code: 'version_not_found' }));
    await expect(createReader({ retries: 0 }).resource('0x1', '0x1::a::B', '5')).rejects.toThrow(/404/);
  });
});
