import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { MAX_CATALOG_BYTES, PricingCache, PRICING_TTL, PRICING_URL } from '../src/pricing.js';
import { fixture } from './fixtures.js';
import * as persistence from '../src/persistence.js';

const catalog = () => ({
  openai: { models: { gpt: { cost: { input: 2, output: 10, cache_read: 0.5, tiers: [{ input: 4, output: 15, cache_read: 1, tier: { type: 'context', size: 1000 } }], context_over_200k: { input: 99, output: 99 } } } } },
  anthropic: { models: { claude: { cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } } } },
});
const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 10 };
const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of clean.splice(0).reverse()) await fn(); vi.useRealTimers(); vi.restoreAllMocks(); });
async function setup(fetcher = vi.fn<typeof fetch>(async () => Response.json(catalog()))) {
  const f = await fixture(false); let now = 1_800_000_000_000;
  const cache = await PricingCache.open(f.dir, fetcher, () => now);
  clean.push(async () => { await cache.close(); f.cleanup(); });
  return { ...f, cache, fetcher, now: () => now, advance: (ms: number) => { now += ms; } };
}
it('fetches once, caches on disk, and prices uncached, cached, and output tokens separately', async () => {
  const f = await setup();
  expect(f.cache.estimate('anthropic', 'claude', usage)).toBeUndefined();
  await f.cache.refresh(); await f.cache.refresh();
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect(f.fetcher.mock.calls[0]).toEqual([PRICING_URL, { redirect: 'error', signal: expect.any(AbortSignal) }]);
  expect(f.cache.estimate('anthropic', 'claude', usage)).toEqual({ usd: 0.0006525, fetchedAt: f.now(), stale: false });
  const restarted = await PricingCache.open(f.dir, f.fetcher, f.now); clean.push(() => restarted.close());
  await restarted.refresh(); expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect(restarted.estimate('anthropic', 'claude', usage)).toEqual(f.cache.estimate('anthropic', 'claude', usage));
});
it('selects the context tier for each call including cached input, with exact thresholds', async () => {
  const f = await setup(); await f.cache.refresh();
  expect(f.cache.estimate('openai', 'gpt', { inputTokens: 500, outputTokens: 100, cacheReadTokens: 500 })?.usd).toBeCloseTo(0.00225);
  expect(f.cache.estimate('openai', 'gpt', { inputTokens: 501, outputTokens: 100, cacheReadTokens: 500 })?.usd).toBeCloseTo(0.004004);
});
it('does not guess model aliases, provider routes, missing cache rates, or invalid counters', async () => {
  const f = await setup(); await f.cache.refresh();
  for (const [provider, model] of [['openrouter', 'gpt'], ['openai', 'gpt-latest'], ['openai', 'constructor'], ['__proto__', 'gpt']]) expect(f.cache.estimate(provider, model, usage)).toBeUndefined();
  expect(f.cache.estimate('openai', 'gpt', usage)).toBeUndefined(); // Cache writes have no rate.
  expect(f.cache.estimate('anthropic', 'claude', { ...usage, inputTokens: NaN })).toBeUndefined();
  expect(f.cache.estimate('anthropic', 'claude', { ...usage, outputTokens: -1 })).toBeUndefined();
});
it('retains last good prices on failures, marks them stale, and backs off retries', async () => {
  const f = await setup(); await f.cache.refresh();
  const saved = readFileSync(join(f.dir, 'pricing.json'), 'utf8');
  f.advance(PRICING_TTL);
  f.fetcher.mockRejectedValueOnce(new Error('offline'));
  await f.cache.refresh(); await f.cache.refresh();
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  expect(readFileSync(join(f.dir, 'pricing.json'), 'utf8')).toBe(saved);
  expect(f.cache.estimate('anthropic', 'claude', usage)?.stale).toBe(true);
  f.advance(3_600_000); await f.cache.refresh();
  expect(f.cache.estimate('anthropic', 'claude', usage)?.stale).toBe(false);
});
it.each([{}, { openai: { models: { gpt: { cost: { input: -1, output: 1 } } } }, anthropic: catalog().anthropic }])('rejects malformed catalogs without replacing the cache', async bad => {
  const f = await setup(); await f.cache.refresh(); const initial = f.cache.estimate('anthropic', 'claude', usage);
  f.advance(PRICING_TTL); f.fetcher.mockResolvedValueOnce(Response.json(bad)); await f.cache.refresh();
  expect(f.cache.estimate('anthropic', 'claude', usage)).toEqual({ ...initial, stale: true });
});
it('cancels catalogs exceeding the size limit without replacing the last good cache', async () => {
  const f = await setup(); await f.cache.refresh();
  const saved = readFileSync(join(f.dir, 'pricing.json'), 'utf8');
  const cancel = vi.fn(); let pulled = 0;
  f.advance(PRICING_TTL);
  f.fetcher.mockResolvedValueOnce(new Response(new ReadableStream({
    pull(controller) { pulled++; controller.enqueue(new Uint8Array(1024 * 1024)); },
    cancel,
  })));
  await f.cache.refresh();
  expect(cancel).toHaveBeenCalledTimes(1);
  // Stops within the limit plus the stream's read-ahead.
  expect(pulled).toBeLessThanOrEqual(MAX_CATALOG_BYTES / (1024 * 1024) + 2);
  expect(readFileSync(join(f.dir, 'pricing.json'), 'utf8')).toBe(saved);
  expect(f.cache.estimate('anthropic', 'claude', usage)?.stale).toBe(true);
});
it('passes shutdown cancellation to in-flight pricing requests', async () => {
  const fetcher = vi.fn<typeof fetch>((_url, options) => new Promise((_resolve, reject) => {
    options!.signal!.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
  }));
  const f = await setup(fetcher); const pending = f.cache.refresh();
  const signal = fetcher.mock.calls[0][1]!.signal!;
  expect(signal.aborted).toBe(false);
  f.cache.dispose();
  await pending;
  expect(signal.aborted).toBe(true);
  expect(f.cache.estimate('anthropic', 'claude', usage)).toBeUndefined();
});
it('recovers from corrupt disk state and does not treat zero prices as missing', async () => {
  const f = await setup(); writeFileSync(join(f.dir, 'pricing.json'), '{broken');
  const data = catalog(); data.anthropic.models.claude.cost = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  f.fetcher.mockResolvedValueOnce(Response.json(data));
  const cache = await PricingCache.open(f.dir, f.fetcher, f.now); clean.push(() => cache.close());
  await cache.refresh(); expect(cache.estimate('anthropic', 'claude', usage)?.usd).toBe(0);
});
it('keeps estimates unavailable until cache persistence completes and drains writes on close', async () => {
  const f = await setup(); const original = persistence.writeJson;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const writer = vi.spyOn(persistence, 'writeJson').mockImplementationOnce(async (path, value) => { await gate; await original(path, value); });
  const pending = f.cache.refresh();
  await vi.waitFor(() => expect(writer).toHaveBeenCalledTimes(1));
  let closed = false;
  const closing = f.cache.close().then(() => { closed = true; });
  try {
    expect(f.cache.estimate('anthropic', 'claude', usage)).toBeUndefined();
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(closed).toBe(false);
  } finally { release(); }
  await Promise.all([pending, closing]);
  const restarted = await PricingCache.open(f.dir, f.fetcher, f.now); clean.push(() => restarted.dispose());
  expect(restarted.estimate('anthropic', 'claude', usage)).toBeDefined();
});
it('shares concurrent refreshes and does not save an in-flight response after disposal', async () => {
  let resolve!: (response: Response) => void;
  const f = await setup(vi.fn<typeof fetch>(() => new Promise(r => { resolve = r; })));
  const first = f.cache.refresh(), second = f.cache.refresh(); expect(first).toBe(second);
  f.cache.dispose(); resolve(Response.json(catalog())); await first;
  expect(f.cache.estimate('anthropic', 'claude', usage)).toBeUndefined();
  await f.cache.refresh(); expect(f.fetcher).toHaveBeenCalledTimes(1);
});
it('refreshes in the background after 24 hours and stops its timer on disposal', async () => {
  vi.useFakeTimers();
  const f = await setup(); f.cache.start(); await f.cache.refresh();
  f.advance(PRICING_TTL); await vi.advanceTimersByTimeAsync(PRICING_TTL);
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  f.cache.dispose(); f.advance(PRICING_TTL); await vi.advanceTimersByTimeAsync(PRICING_TTL);
  expect(f.fetcher).toHaveBeenCalledTimes(2);
});

it('prices the DSH codex route using exact OpenAI model IDs, including after restart', async () => {
  const data = catalog();
  const models: Record<string, typeof data.openai.models.gpt> = data.openai.models;
  models['gpt-5.6-sol'] = models.gpt;
  const f = await setup(vi.fn<typeof fetch>(async () => Response.json(data)));
  await f.cache.refresh();
  const tokens = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 500 };
  const direct = f.cache.estimate('openai', 'gpt-5.6-sol', tokens);
  expect(direct).toBeDefined();
  expect(f.cache.estimate('codex', 'gpt-5.6-sol', tokens)).toEqual(direct);
  expect(f.cache.estimate('codex', 'gpt-5.6-sol-unknown', tokens)).toBeUndefined();
  const restarted = await PricingCache.open(f.dir, f.fetcher, f.now); clean.push(() => restarted.dispose());
  expect(restarted.estimate('codex', 'gpt-5.6-sol', tokens)).toEqual(direct);
});

it.each(['claude', 'claude-code'])('prices %s using Anthropic rates without guessing model IDs', async provider => {
  const f = await setup(); await f.cache.refresh();
  const expected = f.cache.estimate('anthropic', 'claude', usage);
  expect(expected).toBeDefined();
  expect(f.cache.estimate(provider, 'claude', usage)).toEqual(expected);
  expect(f.cache.estimate(provider, 'sonnet', usage)).toBeUndefined();
  const restarted = await PricingCache.open(f.dir, f.fetcher, f.now); clean.push(() => restarted.dispose());
  expect(restarted.estimate(provider, 'claude', usage)).toEqual(expected);
});
it('accepts a near-limit catalog within a bounded event-loop pause', async () => {
  // Realistic shape: many small model records, as models.dev ships for other providers.
  const models: Record<string, unknown> = {};
  const record = (i: number) => ({ id: `model-${i}`, name: `Filler model ${i}`, cost: { input: 1, output: 2, cache_read: 0.1 }, limit: { context: 128000, output: 8192 }, modalities: { input: ['text'], output: ['text'] } });
  const size = JSON.stringify(record(99999)).length + 16;
  for (let i = 0; i < MAX_CATALOG_BYTES * 0.97 / size; i++) models[`model-${i}`] = record(i);
  const body = JSON.stringify({ ...catalog(), filler: { models } });
  expect(body.length).toBeGreaterThan(MAX_CATALOG_BYTES * 0.9);
  expect(body.length).toBeLessThanOrEqual(MAX_CATALOG_BYTES);
  const f = await setup(vi.fn<typeof fetch>(async () => new Response(body)));
  let last = performance.now(), maxGap = 0;
  const timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; }, 1);
  try { await f.cache.refresh(); } finally { clearInterval(timer); }
  expect(f.cache.estimate('anthropic', 'claude', usage)?.stale).toBe(false);
  // Generous for slow CI; measured about 90 ms locally.
  expect(maxGap).toBeLessThan(500);
});
