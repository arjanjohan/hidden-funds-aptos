// Identity-bound USD prices. A quote older than 7 days is not a price.
import { PRICE_MAX_AGE_SECS, type PriceBook } from '../shared/accounting.ts';
import { SUSDE, USDC, USDT } from '../shared/sources/aave-frozen.ts';
import { AMNIS } from '../shared/sources/amnis-withdrawals.ts';
import { APT, MOVE } from '../shared/sources/delegation.ts';
import { AMAPT_FA, MOD, STAPT, STHAPT, WH_USDC } from '../shared/sources/echelon-frozen.ts';
import { KAPT } from '../shared/sources/kofi-receipts.ts';
import { BTCB, CAKE, LZ_BRIDGE } from '../shared/sources/layerzero-claimable.ts';
import { THL } from '../shared/sources/thala-thl.ts';
import { THALA_LSD } from '../shared/sources/thala-unstake.ts';
import type { ChainReader } from '../shared/types.ts';

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
  { asset: MOD, id: 'move-dollar', decimals: 8 },
  { asset: KAPT, id: 'kofi-aptos', decimals: 8 },
  // CoinGecko lists the amAPT coin; this is its paired fungible asset.
  { asset: AMAPT_FA, id: 'amnis-aptos', decimals: 8 },
  // Native fungible assets of the Aave reserves; each id's Aptos contract is this exact address.
  { asset: USDT, id: 'tether', decimals: 6 },
  { asset: USDC, id: 'usd-coin', decimals: 6 },
  { asset: SUSDE, id: 'ethena-staked-usde', decimals: 6 },
];

export async function fetchPrices(nowSecs: number, aptos: ChainReader): Promise<{ prices: PriceBook; errors: string[] }> {
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
  if (prices[APT]) await redemptionPrices(prices, errors, aptos);
  return { prices, errors };
}

/** Staked-APT receipts whose market quote is stale (stAPT's last CoinGecko quote is from 2026-09-03; sthAPT has no
 *  verified id), valued at redemption: the on-chain exchange rate x the APT quote, dated like that quote.
 *  - stAPT unstakes to amAPT at stapt_price (1e8 scale); amAPT redeems 1:1 for APT (simulated, amnis-withdrawals).
 *  - sthAPT unstakes to thAPT at thAPT_sthAPT_exchange_rate (thAPT staked / sthAPT supply); thAPT redeems for APT
 *    less unstake_APT_fee_bps. */
async function redemptionPrices(prices: PriceBook, errors: string[], aptos: ChainReader) {
  const apt = prices[APT];
  try {
    const [[stApt], [thApt, sthApt], [feeBps]] = await Promise.all([
      aptos.view(`${AMNIS}::stapt_token::stapt_price`, []),
      aptos.view(`${THALA_LSD}::staking::thAPT_sthAPT_exchange_rate`, []),
      aptos.view(`${THALA_LSD}::staking::unstake_APT_fee_bps`, []),
    ]);
    prices[STAPT] = { usd: apt.usd * Number(stApt) / 1e8, decimals: 8, at: apt.at, source: 'derived: Amnis stapt_price x APT (coingecko)' };
    prices[STHAPT] = { usd: apt.usd * Number(thApt) / Number(sthApt) * (1 - Number(feeBps) / 10_000), decimals: 8, at: apt.at,
      source: 'derived: Thala thAPT_sthAPT_exchange_rate less unstake_APT_fee_bps x APT (coingecko)' };
  } catch (err) {
    errors.push(`staked-APT redemption rates: ${String(err).slice(0, 200)}`);
  }
}
