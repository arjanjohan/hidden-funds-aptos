// Live check: reads Aptos mainnet from the browser, anonymously. Nothing is sent to this site.
import { useState } from 'react';
import { usd as toUsd, type PriceBook } from '../../shared/accounting.ts';
import { createReader, mapLimit, NETWORKS, normalizeAddress } from '../../shared/chain.ts';
import { ASSETS } from '../../shared/assets.ts';
import { tableProvider, type MarketTable } from '../../shared/market.ts';
import { APT } from '../../shared/sources/delegation.ts';
import { SOURCES } from '../../shared/sources/index.ts';
import type { Memo, Position, ReadContext, ReadResult } from '../../shared/types.ts';
import { date, short, units, usd } from '../lib/format.ts';

const MAX_ADDRESSES = 20;
/** Sources read at once per address: keeps each burst small against the public per-IP limit. */
const SOURCE_CONCURRENCY = 4;
/** Enough retries to outlast the public API's 5-minute rate-limit window (2+4+…+60 s ≈ 5 min). */
const RETRIES = 9;
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

export default function Check({ prices, markets }: { prices: PriceBook; markets?: MarketTable }) {
  const [text, setText] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const { addresses, invalid } = parse(text);

  async function run() {
    setError(''); setNotice(''); setRows([]);
    if (!addresses.length) return setError('Paste at least one Aptos address.');
    if (addresses.length > MAX_ADDRESSES) return setError(`Check at most ${MAX_ADDRESSES} addresses at a time.`);
    try {
      // One anonymous reader and ledger pin per network; sources read on their own chain.
      const contexts = new Map<string, ReadContext>();
      for (const network of new Set(SOURCES.map(s => s.chain))) {
        const chain = createReader({ network, retries: RETRIES, onWait: (_label, ms, status) => {
          if (status === 429) setNotice(`The public ${NETWORKS[network].name} API is rate-limiting this browser; continuing in ${Math.ceil(ms / 1000)} s…`);
        } });
        contexts.set(network, { chain, ledger: await chain.ledger(), memo: memory(), scratch: new Map(),
          market: tableProvider(markets, prices[APT]?.usd ?? null) });
      }
      const out: Row[] = [];
      for (const [i, address] of addresses.entries()) {
        setBusy(`Checking ${i + 1} of ${addresses.length}…`);
        // A source that fails is reported on its own; the others still answer.
        const results = await mapLimit(SOURCES, SOURCE_CONCURRENCY, async s => {
          try { return { sourceId: s.id, result: await s.read(contexts.get(s.chain)!, address) }; }
          catch (err) { return { sourceId: s.id, result: { positions: [], complete: false, errors: [String(err)], ledgerVersion: contexts.get(s.chain)!.ledger.version } }; }
        });
        out.push({ address, results });
        setRows([...out]);
        setNotice('');
      }
    } catch (err) {
      setError(`Could not reach the chain: ${readable(String(err))}`);
    } finally {
      setBusy(''); setNotice('');
    }
  }

  return (
    <div>
      <textarea value={text} onChange={e => setText(e.target.value)} rows={5} placeholder="0x… one address per line"
        style={{ width: '100%', font: '14px ui-monospace, monospace', padding: 10, borderRadius: 8, border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--fg)' }} />
      {invalid.length > 0 && <p className="muted">Not an Aptos address: {invalid.slice(0, 3).join(', ')}{invalid.length > 3 ? '…' : ''}</p>}
      <p><button className="button" onClick={run} disabled={!!busy}>{busy || `Check ${addresses.length || ''} wallet${addresses.length === 1 ? '' : 's'}`}</button></p>
      {notice && <p className="muted" role="status">{notice}</p>}
      {error && <p style={{ color: 'var(--bad)' }}>{error}</p>}
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
  const amount = p.expectedPayout.map(a => `${units(a.raw, ASSETS[a.asset]?.decimals ?? 0)} ${ASSETS[a.asset]?.symbol ?? short(a.asset)}`).join(' + ');
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
