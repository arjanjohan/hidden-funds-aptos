// Live check: reads Aptos mainnet from the browser, anonymously. Nothing is sent to this site.
import { useRef, useState } from 'react';
import { freshPrices, usd as toUsd, type PriceBook } from '../../shared/accounting.ts';
import { createReader, mapLimit, NETWORKS, normalizeAddress } from '../../shared/chain.ts';
import { ASSETS } from '../../shared/assets.ts';
import { tableProvider, type MarketTable } from '../../shared/market.ts';
import { readClassified } from '../../shared/owners.ts';
import { APT } from '../../shared/sources/delegation.ts';
import { SOURCES } from '../../shared/sources/index.ts';
import type { Memo, Position, ReadContext, ReadResult } from '../../shared/types.ts';
import { date, short, units, usd } from '../lib/format.ts';

const MAX_ADDRESSES = 20;
/** Sources read at once per address: keeps each burst small against the public per-IP limit. */
const SOURCE_CONCURRENCY = 4;
/** Enough retries to outlast the public API's 5-minute rate-limit window (2+4+…+60 s ≈ 5 min). */
const RETRIES = 9;
/** Sources that send the address to a third party: read only when the visitor opts in. */
const THIRD_PARTIES = [...new Set(SOURCES.flatMap(s => (s.thirdParty ? [s.thirdParty] : [])))];
const OPT_IN_KEY = 'check:third-party';
const STATUS: Record<Position['status'], string> = {
  recoverable: 'You can claim', team_gated: 'Needs the team', blocked: 'May not work', unknown: 'Unknown',
};

type Row = { address: string; results: { sourceId: string; result: ReadResult }[] };

function parse(text: string): { addresses: string[]; invalid: string[] } {
  const addresses = new Set<string>(), invalid: string[] = [];
  for (const token of text.split(/[\s,;]+/).filter(Boolean)) {
    try { addresses.add(normalizeAddress(token)); } catch { invalid.push(token); }
  }
  return { addresses: [...addresses], invalid };
}

/** A short reason for an error: rate limits by name, anything else truncated. */
function readable(error: string): string {
  return /429|rate limit/i.test(error) ? 'the public API rate limit was reached' : error.slice(0, 120);
}

function memory(): Memo {
  const data = new Map<string, string>();
  return { get: async k => data.get(k), set: async (k, v) => { data.set(k, v); } };
}

export default function Check({ prices: published, markets }: { prices: PriceBook; markets?: MarketTable }) {
  // The snapshot's prices may be old when its weekly run failed; stale quotes are dropped, never shown as values.
  const prices = freshPrices(published, Date.now() / 1000);
  const stalePrices = Object.keys(published).length - Object.keys(prices).length;
  const [text, setText] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const running = useRef(false);   // blocks a second click before the disabled button renders
  // Remembered in this browser only; storage can be unavailable (private windows), so it falls back to off.
  const [thirdParty, setThirdParty] = useState(() => { try { return localStorage.getItem(OPT_IN_KEY) === '1'; } catch { return false; } });
  const sources = SOURCES.filter(s => !s.thirdParty || thirdParty);
  const { addresses, invalid } = parse(text);

  async function run() {
    if (running.current) return;
    setError(''); setNotice(''); setRows([]);
    if (!addresses.length) return setError('Paste at least one Aptos address.');
    if (addresses.length > MAX_ADDRESSES) return setError(`Check at most ${MAX_ADDRESSES} addresses at a time.`);
    // Busy before the first request: connecting can wait out a rate limit for minutes, and the button must stay off.
    running.current = true;
    setBusy('Connecting…');
    try {
      // One anonymous reader and ledger pin per network; sources read on their own chain. A network that cannot be
      // reached only fails its own sources.
      const contexts = new Map<string, ReadContext>(), unreachable = new Map<string, string>();
      for (const network of new Set(sources.map(s => s.chain))) {
        const chain = createReader({ network, retries: RETRIES, onWait: (_label, ms, status) => {
          if (status === 429) setNotice(`The public ${NETWORKS[network].name} API is rate-limiting this browser; continuing in ${Math.ceil(ms / 1000)} s…`);
        } });
        try {
          contexts.set(network, { chain, ledger: await chain.ledger(), memo: memory(), scratch: new Map(),
            market: tableProvider(markets, prices[APT]?.usd ?? null) });
        } catch (err) {
          unreachable.set(network, `could not reach ${NETWORKS[network].name}: ${readable(String(err))}`);
        }
      }
      if (!contexts.size) throw new Error([...unreachable.values()].join('; '));
      const out: Row[] = [];
      for (const [i, address] of addresses.entries()) {
        setBusy(`Checking ${i + 1} of ${addresses.length}…`);
        // A source that fails is reported on its own; the others still answer.
        const results = await mapLimit(sources, SOURCE_CONCURRENCY, async s => {
          const ctx = contexts.get(s.chain);
          if (!ctx) return { sourceId: s.id, result: { positions: [], complete: false, errors: [unreachable.get(s.chain)!], ledgerVersion: '0' } };
          // Same read and owner classification as the pipeline: a resource account or object cannot sign a claim.
          try { return { sourceId: s.id, result: await readClassified(s, ctx, address) }; }
          catch (err) { return { sourceId: s.id, result: { positions: [], complete: false, errors: [String(err)], ledgerVersion: ctx.ledger.version } }; }
        });
        out.push({ address, results });
        setRows([...out]);
        setNotice('');
      }
    } catch (err) {
      setError(`Could not reach the chain: ${readable(String(err))}`);
    } finally {
      running.current = false;
      setBusy(''); setNotice('');
    }
  }

  return (
    <div>
      <textarea value={text} onChange={e => setText(e.target.value)} rows={5} placeholder="0x… one address per line"
        style={{ width: '100%', font: '14px ui-monospace, monospace', padding: 10, borderRadius: 8, border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--fg)' }} />
      {invalid.length > 0 && <p className="muted">Not an Aptos address: {invalid.slice(0, 3).join(', ')}{invalid.length > 3 ? '…' : ''}</p>}
      {THIRD_PARTIES.length > 0 && <p className="muted"><label>
        <input type="checkbox" checked={thirdParty} disabled={!!busy} onChange={e => {
          setThirdParty(e.target.checked);
          try { localStorage.setItem(OPT_IN_KEY, e.target.checked ? '1' : '0'); } catch { /* not remembered */ }
        }} /> Also look up bridge transfers with {THIRD_PARTIES.join(' and ')}. This sends the addresses you check to them.
      </label></p>}
      <p><button className="button" onClick={run} disabled={!!busy}>{busy || `Check ${addresses.length || ''} wallet${addresses.length === 1 ? '' : 's'}`}</button></p>
      {notice && <p className="muted" role="status">{notice}</p>}
      {error && <p style={{ color: 'var(--bad)' }}>{error}</p>}
      {rows.length > 0 && stalePrices > 0 && <p className="muted">{stalePrices} price{stalePrices === 1 ? ' is' : 's are'} older than 7 days and not shown; amounts are still exact.</p>}
      {rows.map(row => <AddressResult key={row.address} row={row} prices={prices} />)}
    </div>
  );
}

function AddressResult({ row, prices }: { row: Row; prices: PriceBook }) {
  const positions = row.results.flatMap(r => r.result.positions);
  const incomplete = row.results.filter(r => !r.result.complete);
  return (
    <section className="card" style={{ marginTop: 16 }}>
      <b style={{ fontSize: 16 }}><code>{short(row.address)}</code></b>
      {positions.length === 0 && <p className="muted">Nothing found in {row.results.length - incomplete.length} of {row.results.length} sources.</p>}
      {positions.map(p => <PositionRow key={p.id} p={p} prices={prices} />)}
      {incomplete.map(r => (
        <p key={r.sourceId} style={{ color: 'var(--bad)' }}>
          {SOURCES.find(s => s.id === r.sourceId)?.title}: could not be read completely ({readable(r.result.errors[0] ?? '')}). Try again later.
        </p>
      ))}
    </section>
  );
}

function PositionRow({ p, prices }: { p: Position; prices: PriceBook }) {
  const source = SOURCES.find(s => s.id === p.source)!;
  const value = toUsd(p.expectedPayout, prices);
  // An asset without a registered display identity is shown in raw units: its decimals are not known here.
  const amount = p.expectedPayout.map(a => ASSETS[a.asset] ? `${units(a.raw, ASSETS[a.asset].decimals)} ${ASSETS[a.asset].symbol}` : `${a.raw} raw units of ${short(a.asset)}`).join(' + ');
  return (
    <div style={{ borderTop: '1px solid var(--line)', marginTop: 12, paddingTop: 12 }}>
      <div><b style={{ display: 'inline', fontSize: 16 }}>{amount}</b>{value !== null && <span className="muted"> ≈ {usd(value)}</span>} · {STATUS[p.status]}</div>
      <div>{source.title} <span className="muted">· {NETWORKS[source.chain].name}</span></div>
      <div className="muted">
        {p.ageBasis === 'unknown' ? 'Claimable since: unknown' : `Claimable since ${date(p.claimableSince)}${p.ageBasis === 'position_interaction' ? ' (estimate)' : ''}`}
        {p.blockers.map(b => ` · ${b.detail}`)}
      </div>
      {p.steps.map((s, i) => <div key={i} className="muted">Call <code>{s.function}({s.arguments.join(', ')})</code></div>)}
      <details><summary className="muted">How to recover</summary><ol>{source.howTo.map(h => <li key={h}>{h}</li>)}</ol></details>
    </div>
  );
}
