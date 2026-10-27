/**
 * recompute-indicator-history.ts (finixhub#256)
 *
 * Rewrites the stored daily RSI 14, ATR 14, ADX 14, +DI/-DI 14 and Stochastic RSI for past days with
 * the corrected (Wilder) formulas. For each day it uses the same 250-day window the daily job uses,
 * so a recomputed day equals what calculate-technical-indicators.ts now stores going forward.
 * Only those six columns are written; prices, ratings and everything else are left as they are.
 *
 * Usage:
 *   npx tsx scripts/recompute-indicator-history.ts                 # dry run, all active assets
 *   npx tsx scripts/recompute-indicator-history.ts --symbol BTC    # dry run, one asset
 *   npx tsx scripts/recompute-indicator-history.ts --write         # write
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { OHLCVData, calculateADX, calculateATR, calculateRSI, calculateStochasticRSI } from './lib/indicators';

dotenv.config();

const WINDOW = 250;
const MIN_HISTORY = 30;
const CONCURRENCY = 8;

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
};
const WRITE = process.argv.includes('--write');

type Row = { date: string; open: number; high: number; low: number; close: number; volume: number; rsi_14: number | null };

async function loadAll(supabase: any, symbol: string): Promise<Row[]> {
  const rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('asset_daily_summary')
      .select('date, open, high, low, close, volume, rsi_14')
      .eq('symbol', symbol)
      .order('date', { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`${symbol}: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return rows.filter((r) => [r.open, r.high, r.low, r.close].every((v) => v !== null && Number.isFinite(Number(v))));
}

async function runPool<T>(items: T[], fn: (t: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

async function recompute(supabase: any, symbol: string) {
  const rows = await loadAll(supabase, symbol);
  const typed: OHLCVData[] = rows.map((r) => ({
    timestamp: r.date, open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume ?? 0),
  }));
  const updates: Array<{ date: string; values: Record<string, unknown>; oldRsi: number | null }> = [];
  for (let i = MIN_HISTORY - 1; i < typed.length; i++) {
    const win = typed.slice(Math.max(0, i - WINDOW + 1), i + 1);
    const prices = win.map((d) => d.close);
    const adx = calculateADX(win, 14);
    updates.push({
      date: rows[i].date,
      oldRsi: rows[i].rsi_14 === null ? null : Number(rows[i].rsi_14),
      values: {
        rsi_14: calculateRSI(prices, 14),
        atr_14: calculateATR(win, 14),
        stochastic_rsi: calculateStochasticRSI(prices, 14),
        ...(adx ? { adx_14: adx.adx, di_plus_14: adx.plusDI, di_minus_14: adx.minusDI } : {}),
      },
    });
  }

  const gaps = updates.filter((u) => u.oldRsi !== null).map((u) => Math.abs((u.values.rsi_14 as number) - (u.oldRsi as number))).sort((a, b) => a - b);
  const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
  console.log(`${symbol}: ${rows.length} days, ${updates.length} to ${WRITE ? 'write' : 'rewrite (dry run)'}; RSI change median ${median.toFixed(2)} pts, max ${(gaps.at(-1) ?? 0).toFixed(2)} pts`);

  if (!WRITE) return { symbol, written: 0, failed: 0 };
  let written = 0, failed = 0;
  await runPool(updates, async (u) => {
    const { error } = await supabase.from('asset_daily_summary').update(u.values).eq('symbol', symbol).eq('date', u.date);
    if (error) { failed++; console.error(`  ${symbol} ${u.date}: ${error.message}`); } else written++;
  });
  return { symbol, written, failed };
}

async function main() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  const supabase = createClient(url, key);

  const only = arg('--symbol');
  let symbols: string[];
  if (only) {
    symbols = [only.toUpperCase()];
  } else {
    const { data, error } = await supabase.from('assets').select('symbol').eq('is_active', true);
    if (error) throw new Error(error.message);
    symbols = (data ?? []).map((a: { symbol: string }) => a.symbol);
  }

  console.log(`${WRITE ? 'WRITING' : 'DRY RUN'}: ${symbols.length} assets, window ${WINDOW} days\n`);
  let written = 0, failed = 0;
  for (const s of symbols) {
    try {
      const r = await recompute(supabase, s);
      written += r.written; failed += r.failed;
    } catch (e) {
      failed++;
      console.error(`${s}: ${(e as Error).message}`);
    }
  }
  console.log(`\nDone. Rows written: ${written}. Failures: ${failed}.`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
