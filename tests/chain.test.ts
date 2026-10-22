import { afterEach, describe, expect, it, vi } from 'vitest';
import { readers, RequestCapReached } from '../src/node/client.ts';
import { canonicalType, createReader, gqlAll, withOwnResources } from '../src/shared/chain.ts';
import { addr, fakeChain } from './fake-chain.ts';

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

describe('own resources', () => {
  it('reads all of an account\'s resources in one page, and refuses a list that needs more pages', async () => {
    vi.stubGlobal('fetch', async (url: string) => (url.includes('/0x2/')
      ? new Response(JSON.stringify([{ type: '0x1::a::B', data: {} }]), { status: 200, headers: { 'x-aptos-cursor': 'next' } })
      : url.includes('/0x3/') ? respond(404, { error_code: 'account_not_found' }) : respond(200, [{ type: '0x1::a::B', data: { v: 1 } }])));
    const r = createReader({ retries: 0 });
    expect(await r.resources('0x1', '5')).toEqual([{ type: '0x1::a::B', data: { v: 1 } }]);
    expect(await r.resources('0x2', '5')).toBeNull();
    expect(await r.resources('0x3', '5')).toEqual([]);
  });

  it('answers the owner\'s resource reads at the pinned version from one bulk read, whatever the address spelling', async () => {
    expect(canonicalType('0x1::coin::CoinStore<0xabc::m::T, 0x1::aptos_coin::AptosCoin>'))
      .toBe(`${addr('1')}::coin::CoinStore<${addr('abc')}::m::T,${addr('1')}::aptos_coin::AptosCoin>`);
    const owner = addr('77');
    const c = fakeChain({ resources: () => [{ type: '0x1::coin::CoinStore<0xabc::m::T>', data: { coin: 5 } }], resource: () => ({ direct: true }) });
    const own = withOwnResources(c, owner, '9');
    expect(await own.resource(owner, `0x1::coin::CoinStore<${addr('abc')}::m::T>`, '9')).toEqual({ coin: 5 });
    expect(await own.resource(owner, '0x1::x::Absent', '9')).toBeNull();
    expect(c.calls).toEqual([`resources ${owner}`]);
    // Another address or version is read directly.
    expect(await own.resource(addr('78'), '0x1::x::Y', '9')).toEqual({ direct: true });
    expect(await own.resource(owner, '0x1::x::Y', '8')).toEqual({ direct: true });
    // A list longer than one page: every read goes direct.
    const long = withOwnResources(fakeChain({ resources: () => null, resource: () => ({ direct: true }) }), owner, '9');
    expect(await long.resource(owner, '0x1::x::Absent', '9')).toEqual({ direct: true });
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

