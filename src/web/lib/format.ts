export function usd(n: number): string {
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(n < 10 ? 2 : 0)}`;
}

export function count(n: number): string {
  return n.toLocaleString('en-US');
}

export function units(raw: string, decimals: number): string {
  const value = Number(raw) / 10 ** decimals;
  return value.toLocaleString('en-US', { maximumFractionDigits: value < 1 ? 6 : 2 });
}

export function date(iso?: string): string {
  return iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—';
}

export function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
