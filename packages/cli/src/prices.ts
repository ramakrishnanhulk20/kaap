// Today's USD prices from 1Click's public token list (`GET /v0/tokens`, no key), the list the
// census priced with. kaap-core turns it into its price table (`pricesFromTokens`), so a token is
// keyed by its exact contract id, never by symbol (C3). When the list cannot be read every token is
// unpriced, which is UNKNOWN_VALUE, never zero (C2). Testnet tokens have no market price, so a
// testnet check is always unpriced.

import { MAX_PRICE_LIST_BYTES, RPC_TIMEOUT_MS } from './caps.js';
import type { Core, Prices } from './core.js';
import type { RateLimiter } from './limiter.js';
import type { Network } from './rpc.js';
import type { Transport } from './net.js';

export const PRICE_LIST_URL = 'https://1click.chaindefuser.com/v0/tokens';

export interface PriceRead {
  prices: Prices;
  source: string;
}

export async function readPrices(network: Network, core: Core, transport: Transport, limiter: RateLimiter): Promise<PriceRead> {
  const none = (why: string): PriceRead => ({ prices: { usd_by_token: {} }, source: `none: ${why}, so every token counts as unpriced` });
  if (network !== 'mainnet') return none('testnet tokens have no market price');
  try {
    await limiter.slot();
    const response = await transport({ url: PRICE_LIST_URL, method: 'GET', timeoutMs: RPC_TIMEOUT_MS, maxBytes: MAX_PRICE_LIST_BYTES });
    if (response.status !== 200) return none(`the 1Click token list answered HTTP ${response.status}`);
    const prices = core.pricesFromTokens(response.text);
    const near = prices.usd_by_token['near'];
    const count = Object.keys(prices.usd_by_token).length;
    return { prices, source: `1Click token list, ${count} priced tokens${near ? `, NEAR at ${near[1]} USD` : ''}` };
  } catch {
    return none('the 1Click token list could not be read');
  }
}
