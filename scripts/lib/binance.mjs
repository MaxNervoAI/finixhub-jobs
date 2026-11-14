/**
 * Binance spot market data from the global venue only.
 *
 * The jobs used to try api.binance.com and fall back to api.binance.us. GitHub's US runners are
 * geo-blocked on .com (HTTP 451), so the fallback fired silently: volumes and trade counts came from
 * Binance.US, a venue with roughly 0.3% of the global volume, and prices differed slightly. On days a
 * runner was not blocked the data came from .com instead, so the stored history flips between the two
 * scales. data-api.binance.vision serves the same global market data without the geo-block, and
 * there is deliberately no .us fallback: a failed request is skipped and retried next run, never
 * replaced with another venue's numbers.
 */

export const BINANCE_HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com'];

/**
 * @param {string} path e.g. /api/v3/klines?symbol=BTCUSDT&interval=1d&limit=2
 * @param {{ fetchImpl?: typeof fetch, hosts?: string[] }} [options]
 * @returns {Promise<{ res: Response, host: string }>} the first successful response
 */
export async function fetchBinanceGlobal(path, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const hosts = options.hosts ?? BINANCE_HOSTS;
  const failures = [];
  for (const host of hosts) {
    try {
      const res = await fetchImpl(`${host}${path}`);
      if (res.ok) return { res, host };
      failures.push(`${host} ${res.status}`);
      if (res.status === 418 || res.status === 429) break; // rate limited: another host will not help
    } catch (err) {
      failures.push(`${host} ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`Binance request failed (${failures.join('; ')})`);
}
