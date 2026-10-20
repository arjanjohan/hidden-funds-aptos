// Identity-bound USD prices. A quote older than 7 days is not a price.
import { PRICE_MAX_AGE_SECS, type PriceBook } from '../shared/accounting.ts';
import { APT, MOVE } from '../shared/sources/delegation.ts';
import { WH_USDC } from '../shared/sources/echelon-sunset.ts';
import { BTCB, CAKE, LZ_BRIDGE } from '../shared/sources/layerzero-claimable.ts';
import { THL } from '../shared/sources/thala-thl.ts';

const COINGECKO = [
  { asset: APT, id: 'aptos', decimals: 8 },
  { asset: THL, id: 'thala', decimals: 8 },
  { asset: MOVE, id: 'movement', decimals: 8 },
  // LayerZero Aptos Bridge coins have their own ids; bridged USDD has none and stays unpriced.
  { asset: `${LZ_BRIDGE}::asset::USDC`, id: 'layerzero-bridged-usdc-aptos', decimals: 6 },
  { asset: `${LZ_BRIDGE}::asset::USDT`, id: 'layerzero-bridged-usdt-aptos', decimals: 6 },
  { asset: `${LZ_BRIDGE}::asset::WETH`, id: 'layerzero-bridged-weth-aptos', decimals: 6 },
  { asset: `${LZ_BRIDGE}::asset::WBTC`, id: 'layerzero-bridged-wbtc-aptos', decimals: 6 },
  // CAKE and BTC.b on Aptos are the tokens' own LayerZero OFTs (mint/burn, redeemable 1:1), priced as the token.
  { asset: CAKE, id: 'pancakeswap-token', decimals: 8 },
  { asset: BTCB, id: 'bitcoin-avalanche-bridged-btc-b', decimals: 8 },
  { asset: WH_USDC, id: 'usd-coin-wormhole-from-ethereum', decimals: 6 },
];

export async function fetchPrices(nowSecs: number): Promise<{ prices: PriceBook; errors: string[] }> {
  const prices: PriceBook = {};
  const errors: string[] = [];
  try {
    const ids = COINGECKO.map(c => c.id).join(',');
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_last_updated_at=true`,
      { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body: any = await res.json();
    for (const c of COINGECKO) {
      const q = body[c.id];
      if (!q?.usd || q.usd <= 0) { errors.push(`no quote for ${c.id}`); continue; }
      if (nowSecs - q.last_updated_at > PRICE_MAX_AGE_SECS) { errors.push(`quote for ${c.id} older than 7 days`); continue; }
      prices[c.asset] = { usd: q.usd, decimals: c.decimals, at: new Date(q.last_updated_at * 1000).toISOString(), source: 'coingecko simple/price' };
    }
  } catch (err) {
    errors.push(`coingecko: ${String(err).slice(0, 200)}`);
  }
  return { prices, errors };
}
