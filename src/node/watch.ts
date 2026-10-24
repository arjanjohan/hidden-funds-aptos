// Weekly wind-down watch: flags protocols the registry treats as live whose public signals say they may be closing, so
// a wind-down (Echo's was announced the day we last checked it) is noticed within a week. Signals are deterministic and
// need no key: DefiLlama newly marking the protocol dead, its Aptos/Movement TVL falling 80% or more in 30 days, its
// website's domain no longer resolving. Each flagged protocol gets one open GitHub issue (label wind-down-watch), opened
// or brought up to date here; a person decides what it means and closes it. A closed issue acknowledges the signals it
// was raised for: they do not open another one, a new kind of signal does.
//
// Usage: node src/node/watch.ts [--dry-run]   (without GITHUB_TOKEN it is always a dry run)
import { lookup } from 'node:dns/promises';
import { appendFileSync } from 'node:fs';
import { PROTOCOLS, type ProtocolEntry, type ProtocolStatus } from '../shared/protocols.ts';
import { SOURCES } from '../shared/sources/index.ts';

/** Registry statuses that mean "live as far as we know": a wind-down there changes what we count. */
const LIVE_STATUSES: ProtocolStatus[] = ['not_left_behind', 'dormant', 'needs_decision'];
/** A drop to this share of the TVL 30 days earlier, from at least MIN_TVL, is a signal. */
const DROP_TO = 0.2;
const MIN_TVL = 10_000;
const WINDOW_SECS = 30 * 86_400;
export const LABEL = 'wind-down-watch';
const CHAIN_NAMES = { aptos: 'Aptos', movement: 'Movement' } as const;

/** The entries watched: live by status, or implemented with every source on a live protocol; each needs a DefiLlama slug. */
export function watched(entries: ProtocolEntry[] = PROTOCOLS): ProtocolEntry[] {
  const live = new Set(SOURCES.filter(s => s.protocolStatus.state === 'live').map(s => s.id));
  return entries.filter(e => e.defillama && (LIVE_STATUSES.includes(e.status)
    || (e.status === 'implemented' && (e.sources ?? []).length > 0 && e.sources!.every(id => live.has(id)))));
}

export interface Listing { slug: string; url?: string; deadUrl?: boolean | null; deadFrom?: string | null }
/** Daily TVL per chain name, as DefiLlama's protocol endpoint gives it. */
export type TvlSeries = Record<string, { date: number; totalLiquidityUSD: number }[]>;
export interface Signal { code: 'llama_dead' | 'tvl_drop' | 'site_down'; detail: string }

/** The TVL across the entry's chains at the last point, and at the last point at least 30 days before it. */
export function tvlChange(entry: ProtocolEntry, series: TvlSeries): { now: number; then: number } | null {
  const chains = entry.chains.map(c => series[CHAIN_NAMES[c]]).filter(s => s?.length);
  if (!chains.length) return null;
  const end = Math.max(...chains.map(s => s[s.length - 1].date));
  const at = (s: TvlSeries[string], t: number) => [...s].reverse().find(p => p.date <= t)?.totalLiquidityUSD ?? 0;
  return { now: chains.reduce((sum, s) => sum + at(s, end), 0), then: chains.reduce((sum, s) => sum + at(s, end - WINDOW_SECS), 0) };
}

export function assess(entry: ProtocolEntry, listing: Listing | undefined, series: TvlSeries | undefined, site: 'ok' | 'missing' | 'unchecked'): Signal[] {
  const signals: Signal[] = [];
  // The registry records the dead flags it knows; one it does not is new.
  if (listing && (listing.deadFrom || listing.deadUrl) && !entry.dead)
    signals.push({ code: 'llama_dead', detail: `DefiLlama now marks it dead${listing.deadFrom ? ` from ${listing.deadFrom}` : ''}${listing.deadUrl ? ' (its website flagged dead)' : ''}.` });
  const change = series ? tvlChange(entry, series) : null;
  if (change && change.then >= MIN_TVL && change.now <= change.then * DROP_TO)
    signals.push({ code: 'tvl_drop', detail: `TVL on ${entry.chains.map(c => CHAIN_NAMES[c]).join(' and ')} fell from $${Math.round(change.then).toLocaleString('en-US')} to $${Math.round(change.now).toLocaleString('en-US')} in 30 days (DefiLlama).` });
  if (site === 'missing' && listing?.url)
    signals.push({ code: 'site_down', detail: `Its website's domain (${new URL(listing.url).hostname}) no longer resolves.` });
  return signals;
}

export const issueTitle = (entry: ProtocolEntry) => `Possible wind-down: ${entry.name}`;
/** The signal codes an issue was raised for, kept in its body: every one it was ever raised for, so closing it
 *  acknowledges them all even when only some show now. */
const marker = (codes: Iterable<string>) => `<!-- ${LABEL}: ${[...new Set(codes)].sort().join(',')} -->`;
export const markedCodes = (body: string | null | undefined) => new Set(body?.match(new RegExp(`<!-- ${LABEL}: ([a-z_,]*) -->`))?.[1].split(',').filter(Boolean) ?? []);

export interface Issue { number: number; title: string; body?: string | null; state: 'open' | 'closed' }
/** Update the open issue; skip when the closed ones together acknowledge every current signal; else open one. */
export function decide(entry: ProtocolEntry, signals: Signal[], issues: Issue[]): { action: 'update' | 'create'; issue?: number } | { action: 'acknowledged'; issue: number } {
  const mine = issues.filter(i => i.title === issueTitle(entry));
  const open = mine.find(i => i.state === 'open');
  if (open) return { action: 'update', issue: open.number };
  const closed = mine.filter(i => i.state === 'closed');
  const acknowledged = new Set(closed.flatMap(i => [...markedCodes(i.body)]));
  return closed.length && signals.every(s => acknowledged.has(s.code)) ? { action: 'acknowledged', issue: closed[0].number } : { action: 'create' };
}

export function issueBody(entry: ProtocolEntry, signals: Signal[], today: string, raisedBefore: Iterable<string> = []): string {
  return [
    `The weekly wind-down watch (\`.github/workflows/watch.yml\`) flagged **${entry.name}** (registry \`${entry.id}\`, status \`${entry.status}\`, checked ${entry.checkedAt ?? 'never'}):`,
    '',
    ...signals.map(s => `- ${s.detail}`),
    '',
    `Registry reason: ${entry.reason}`,
    '',
    `Look for a notice (site, X, Discord, docs). If it is closing: update the registry entry, and size or add a source. If not: record why in the entry and close this issue. DefiLlama: https://defillama.com/protocol/${entry.defillama}`,
    '',
    `_Last flagged ${today}. Closing this acknowledges these signals: only a new kind of signal opens another issue._`,
    marker([...raisedBefore, ...signals.map(s => s.code)]),
  ].join('\n');
}

async function json(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/** Whether a site's domain resolves: only a definite "no such name" counts as missing (timeouts and blocks do not). */
async function siteState(url: string | undefined): Promise<'ok' | 'missing' | 'unchecked'> {
  if (!url) return 'unchecked';
  try { await lookup(new URL(url).hostname); return 'ok'; }
  catch (err: any) { return err?.code === 'ENOTFOUND' || err?.code === 'ENODATA' ? 'missing' : 'unchecked'; }
}

async function github(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${path}`, { ...init, headers: {
    authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' } });
  if (!res.ok) throw new Error(`GitHub ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function main() {
  const dryRun = process.argv.includes('--dry-run') || !process.env.GITHUB_TOKEN || !process.env.GITHUB_REPOSITORY;
  const today = new Date().toISOString().slice(0, 10);
  const entries = watched();
  const listings = new Map<string, Listing>((await json('https://api.llama.fi/protocols') as Listing[]).map(l => [l.slug, l]));
  const flagged: { entry: ProtocolEntry; signals: Signal[] }[] = [];
  const unread: string[] = [];
  for (const entry of entries) {
    const listing = listings.get(entry.defillama!);
    let series: TvlSeries | undefined;
    try { series = Object.fromEntries(Object.entries((await json(`https://api.llama.fi/protocol/${entry.defillama}`)).chainTvls ?? {}).map(([k, v]: [string, any]) => [k, v.tvl ?? []])); }
    catch { unread.push(entry.id); }
    const signals = assess(entry, listing, series, await siteState(listing?.url));
    if (signals.length) flagged.push({ entry, signals });
  }
  const lines = [`Watched ${entries.length} registry entries; flagged ${flagged.length}${unread.length ? `; TVL not read for ${unread.join(', ')}` : ''}.`,
    ...flagged.map(f => `- ${f.entry.name}: ${f.signals.map(s => s.detail).join(' ')}`)];
  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  if (dryRun) return;
  const issues: Issue[] = await github(`/issues?state=all&labels=${LABEL}&per_page=100`);
  for (const { entry, signals } of flagged) {
    const d = decide(entry, signals, issues);
    if (d.action === 'update') {
      const body = issueBody(entry, signals, today, markedCodes(issues.find(i => i.number === d.issue)?.body));
      await github(`/issues/${d.issue}`, { method: 'PATCH', body: JSON.stringify({ body }) });
    } else if (d.action === 'create') {
      await github('/issues', { method: 'POST', body: JSON.stringify({ title: issueTitle(entry), body: issueBody(entry, signals, today), labels: [LABEL] }) });
    }
    else console.log(`${entry.name}: acknowledged in #${d.issue}`);
  }
}

if (import.meta.main) await main();
