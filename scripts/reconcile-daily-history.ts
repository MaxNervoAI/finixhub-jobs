/**
 * reconcile-daily-history.ts
 *
 * Rewrites the OHLCV columns of past asset_daily_summary rows from the final UTC-day Binance candle.
 * Those rows were built from the rolling 24h ticker at job time (mid-morning UTC) and never corrected,
 * so a past day's open/high/low/close/volume described the 24 hours before the job ran, not the day.
 *
 * The history is also a mix of two venues: the jobs fell back to Binance.US when GitHub's runners were
 * geo-blocked on Binance.com, so volume and trade count flip between ~50 BTC/day (US) and ~15,000+
 * (global), and April 2026 contains generated mock rows. Every row is rewritten from the global venue
 * (see lib/binance.mjs), and rows whose data_source was not 'binance' are counted in the report.
 *
 * Only completed UTC days are touched (never today's row). Written columns: open, high, low, close,
 * volume, quote_volume, trade_count, taker_buy_volume, taker_sell_volume, change_percent_24h,
 * is_complete, data_source. With --write the 1d candles already present in market_data_ohlcv are
 * rewritten too. Indicator columns are left alone: re-run recompute-indicator-history.ts afterwards so
 * RSI/ATR/ADX/DI/Stochastic RSI are recomputed from the corrected prices.
 *
 * Usage:
 *   npx tsx scripts/reconcile-daily-history.ts                 # dry run, all active assets
 *   npx tsx scripts/reconcile-daily-history.ts --symbol BTC    # dry run, one asset
 *   npx tsx scripts/reconcile-daily-history.ts --write         # write
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { completedDays, finalizedBar, type DailyBar, type Kline } from './lib/daily-bars';
import { fetchBinanceGlobal } from './lib/binance.mjs';

dotenv.config();

const CONCURRENCY = 4;
const KLINE_PAGE = 1000;
const DAY_MS = 24 * 3600 * 1000;

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
};
const WRITE = process.argv.includes('--write');

type StoredRow = {
  date: string; open: number | null; high: number | null; low: number | null; close: number | null;
  volume: number | null; quote_volume: number | null; trade_count: number | null; data_source: string | null;
};

const hostsUsed = new Set<string>();

async function fetchKlinePage(symbol: string, startMs: number): Promise<Kline[]> {
  const { res, host } = await fetchBinanceGlobal(`/api/v3/klines?symbol=${symbol}&interval=1d&startTime=${startMs}&limit=${KLINE_PAGE}`);
  hostsUsed.add(host);
  return res.json();
}

async function fetchDailyKlines(symbol: string, startMs: number): Promise<Kline[]> {
  const out: Kline[] = [];
  let cursor = startMs;
  for (let page = 0; page < 20; page++) {
    const rows = await fetchKlinePage(symbol, cursor);
    if (!rows.length) break;
    out.push(...rows);
    cursor = Number(rows[rows.length - 1][6]) + 1;
    if (rows.length < KLINE_PAGE) break;
  }
  return out;
}

async function loadStored(supabase: any, symbol: string): Promise<Map<string, StoredRow>> {
  const byDate = new Map<string, StoredRow>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('asset_daily_summary')
      .select('date, open, high, low, close, volume, quote_volume, trade_count, data_source')
      .eq('symbol', symbol)
      .order('date', { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`${symbol}: ${error.message}`);
    for (const r of data ?? []) byDate.set(r.date, r);
    if (!data || data.length < 1000) break;
  }
  return byDate;
}

const pctDiff = (a: number | null, b: number) => (a === null || !(b > 0) ? null : (Math.abs(a - b) / b) * 100);

interface AssetResult {
  symbol: string;
  examined: number;
  missing: number;
  changed: number;
  nonBinanceSource: number;
  closeDiffs: number[];
  worst: { date: string; stored: number | null; final: number; diffPct: number } | null;
  error?: string;
}

async function reconcile(supabase: any, symbol: string, binanceSymbol: string, now: number): Promise<AssetResult> {
  const result: AssetResult = { symbol, examined: 0, missing: 0, changed: 0, nonBinanceSource: 0, closeDiffs: [], worst: null };
  try {
    const stored = await loadStored(supabase, symbol);
    const firstDate = [...stored.keys()].sort()[0];
    if (!firstDate) return result;
    const klines = await fetchDailyKlines(binanceSymbol, Date.parse(`${firstDate}T00:00:00Z`) - DAY_MS);
    const bars: DailyBar[] = completedDays(klines, now).map(finalizedBar).filter((b) => b.date >= firstDate);

    const toWrite: Array<Record<string, unknown>> = [];
    for (const bar of bars) {
      const row = stored.get(bar.date);
      result.examined++;
      if (!row) {
        result.missing++;
      } else {
        if (row.data_source !== 'binance') result.nonBinanceSource++;
        const closeDiff = pctDiff(row.close === null ? null : Number(row.close), bar.close);
        const volDiff = pctDiff(row.volume === null ? null : Number(row.volume), bar.volume);
        const differs = closeDiff === null || closeDiff > 0.05 || volDiff === null || volDiff > 1;
        if (!differs) continue;
        result.changed++;
        if (closeDiff !== null) {
          result.closeDiffs.push(closeDiff);
          if (!result.worst || closeDiff > result.worst.diffPct) {
            result.worst = { date: bar.date, stored: Number(row.close), final: bar.close, diffPct: closeDiff };
          }
        }
      }
      toWrite.push({ symbol, ...bar, data_source: 'binance' });
    }

    if (WRITE) {
      for (let i = 0; i < toWrite.length; i += 200) {
        const { error } = await supabase
          .from('asset_daily_summary')
          .upsert(toWrite.slice(i, i + 200), { onConflict: 'symbol,date', ignoreDuplicates: false });
        if (error) throw new Error(`${symbol} upsert: ${error.message}`);
      }
      // Only rewrite candles that already exist: the table is a short-retention cache, not a place to grow history.
      const { data: existing, error: candleErr } = await supabase
        .from('market_data_ohlcv').select('timestamp').eq('symbol', symbol).eq('timeframe', '1d');
      if (candleErr) throw new Error(`${symbol} candle read: ${candleErr.message}`);
      const candleDates = new Set((existing ?? []).map((r: any) => String(r.timestamp).slice(0, 10)));
      const candles = bars.filter((b) => candleDates.has(b.date)).map((b) => ({
        symbol, timeframe: '1d', timestamp: `${b.date}T00:00:00+00:00`,
        open: b.open, high: b.high, low: b.low, close: b.close,
        volume: b.volume, quote_volume: b.quote_volume, trade_count: b.trade_count,
      }));
      for (let i = 0; i < candles.length; i += 200) {
        const { error } = await supabase
          .from('market_data_ohlcv')
          .upsert(candles.slice(i, i + 200), { onConflict: 'symbol,timeframe,timestamp', ignoreDuplicates: false });
        if (error) throw new Error(`${symbol} candle upsert: ${error.message}`);
      }
    }
  } catch (err: any) {
    result.error = err.message;
  }
  return result;
}

async function runPool<T>(items: T[], fn: (t: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

const quantile = (sorted: number[], q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0);

async function main() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  const supabase = createClient(url, key);

  let query = supabase.from('assets').select('symbol, binance_symbol').eq('is_active', true).not('binance_symbol', 'is', null);
  const only = arg('--symbol');
  if (only) query = query.eq('symbol', only.toUpperCase());
  const { data: assets, error } = await query;
  if (error) throw new Error(error.message);

  console.log(`${WRITE ? 'WRITE' : 'DRY RUN'}: reconciling ${assets?.length ?? 0} assets`);
  const now = Date.now();
  const results: AssetResult[] = [];
  await runPool(assets ?? [], async (a: any) => {
    const r = await reconcile(supabase, a.symbol, a.binance_symbol, now);
    results.push(r);
    console.log(`${r.error ? 'FAIL' : 'ok  '} ${r.symbol.padEnd(8)} examined=${r.examined} missing=${r.missing} changed=${r.changed} nonBinanceSource=${r.nonBinanceSource}${r.error ? ` error=${r.error}` : ''}`);
  });

  const diffs = results.flatMap((r) => r.closeDiffs).sort((a, b) => a - b);
  const failed = results.filter((r) => r.error);
  console.log('\n== Summary ==');
  console.log(`assets ok=${results.length - failed.length} failed=${failed.length}`);
  console.log(`hosts used: ${[...hostsUsed].join(', ') || 'none'}`);
  console.log(`rows with data_source other than binance (replaced): ${results.reduce((s, r) => s + r.nonBinanceSource, 0)}`);
  console.log(`rows examined=${results.reduce((s, r) => s + r.examined, 0)} missing=${results.reduce((s, r) => s + r.missing, 0)} changed=${results.reduce((s, r) => s + r.changed, 0)}`);
  console.log(`close difference among changed rows: median=${quantile(diffs, 0.5).toFixed(2)}% p90=${quantile(diffs, 0.9).toFixed(2)}% max=${(diffs[diffs.length - 1] ?? 0).toFixed(2)}%`);
  const worst = results.map((r) => r.worst && { symbol: r.symbol, ...r.worst }).filter(Boolean).sort((a: any, b: any) => b.diffPct - a.diffPct).slice(0, 5);
  for (const w of worst as any[]) console.log(`worst ${w.symbol} ${w.date}: stored ${w.stored} -> final ${w.final} (${w.diffPct.toFixed(2)}%)`);
  if (failed.length) console.log(`failed assets: ${failed.map((f) => f.symbol).join(', ')}`);
  console.log(WRITE ? 'Written.' : 'Nothing written (dry run). Re-run with --write to apply.');
}

main().then(() => process.exit(0)).catch((err) => { console.error('Fatal:', err); process.exit(1); });
