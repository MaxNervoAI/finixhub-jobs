// Run: node --test scripts/lib/binance.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BINANCE_HOSTS, fetchBinanceGlobal } from './binance.mjs';

const ok = (body = []) => ({ ok: true, status: 200, json: async () => body });
const status = (code) => ({ ok: false, status: code });

test('the hosts are the global venue only, never Binance.US', () => {
  assert.ok(BINANCE_HOSTS.length >= 1);
  for (const h of BINANCE_HOSTS) assert.ok(!h.includes('binance.us'), h);
});

test('the geo-unrestricted data host is tried first', async () => {
  const seen = [];
  const fetchImpl = async (url) => { seen.push(url); return ok(); };
  const { host } = await fetchBinanceGlobal('/api/v3/ping', { fetchImpl });
  assert.equal(host, 'https://data-api.binance.vision');
  assert.equal(seen.length, 1);
});

test('a geo-block (451) on one host falls through to the next global host', async () => {
  const fetchImpl = async (url) => (url.startsWith('https://data-api.binance.vision') ? status(451) : ok());
  const { host } = await fetchBinanceGlobal('/api/v3/ping', { fetchImpl });
  assert.equal(host, 'https://api.binance.com');
});

test('when every global host fails it throws instead of using another venue', async () => {
  const seen = [];
  const fetchImpl = async (url) => { seen.push(url); return status(451); };
  await assert.rejects(() => fetchBinanceGlobal('/api/v3/ping', { fetchImpl }), /Binance request failed/);
  assert.ok(seen.every((u) => !u.includes('binance.us')));
});

test('rate limiting stops the walk (another host will not help)', async () => {
  const seen = [];
  const fetchImpl = async (url) => { seen.push(url); return status(429); };
  await assert.rejects(() => fetchBinanceGlobal('/api/v3/ping', { fetchImpl }));
  assert.equal(seen.length, 1);
});

test('a network error on one host falls through', async () => {
  const fetchImpl = async (url) => { if (url.includes('vision')) throw new Error('ECONNRESET'); return ok(); };
  const { host } = await fetchBinanceGlobal('/api/v3/ping', { fetchImpl });
  assert.equal(host, 'https://api.binance.com');
});
