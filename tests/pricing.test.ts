import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { PricingCache, PRICING_TTL, PRICING_URL } from '../src/pricing.js';
import { fixture } from './fixtures.js';

const catalog = () => ({
  openai: { models: { gpt: { cost: { input: 2, output: 10, cache_read: 0.5, tiers: [{ input: 4, output: 15, cache_read: 1, tier: { type: 'context', size: 1000 } }], context_over_200k: { input: 99, output: 99 } } } } },
  anthropic: { models: { claude: { cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } } } },
});
const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 10 };
const clean: (() => void)[] = [];
afterEach(() => { clean.splice(0).forEach(fn => fn()); vi.useRealTimers(); });
function setup(fetcher = vi.fn<typeof fetch>(async () => Response.json(catalog()))) {
  const f = fixture(false); let now = 1_800_000_000_000;
  const cache = new PricingCache(f.dir, fetcher, () => now);
  clean.push(() => { cache.dispose(); f.cleanup(); });
  return { ...f, cache, fetcher, now: () => now, advance: (ms: number) => { now += ms; } };
}
it('fetches once, caches on disk, and prices uncached, cached, and output tokens separately', async () => {
  const f = setup();
  expect(f.cache.estimate('anthropic', 'claude', usage)).toBeUndefined();
  await f.cache.refresh(); await f.cache.refresh();
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect(f.fetcher.mock.calls[0]).toEqual([PRICING_URL, { redirect: 'error', signal: expect.any(AbortSignal) }]);
  expect(f.cache.estimate('anthropic', 'claude', usage)).toEqual({ usd: 0.0006525, fetchedAt: f.now(), stale: false });
  const restarted = new PricingCache(f.dir, f.fetcher, f.now); clean.push(() => restarted.dispose());
  await restarted.refresh(); expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect(restarted.estimate('anthropic', 'claude', usage)).toEqual(f.cache.estimate('anthropic', 'claude', usage));
});
it('selects the context tier for each call including cached input, with exact thresholds', async () => {
  const f = setup(); await f.cache.refresh();
  expect(f.cache.estimate('openai', 'gpt', { inputTokens: 500, outputTokens: 100, cacheReadTokens: 500 })?.usd).toBeCloseTo(0.00225);
  expect(f.cache.estimate('openai', 'gpt', { inputTokens: 501, outputTokens: 100, cacheReadTokens: 500 })?.usd).toBeCloseTo(0.004004);
});
it('does not guess model aliases, provider routes, missing cache rates, or invalid counters', async () => {
  const f = setup(); await f.cache.refresh();
  for (const [provider, model] of [['openrouter', 'gpt'], ['openai', 'gpt-latest'], ['openai', 'constructor'], ['__proto__', 'gpt']]) expect(f.cache.estimate(provider, model, usage)).toBeUndefined();
  expect(f.cache.estimate('openai', 'gpt', usage)).toBeUndefined(); // Cache writes have no rate.
  expect(f.cache.estimate('anthropic', 'claude', { ...usage, inputTokens: NaN })).toBeUndefined();
  expect(f.cache.estimate('anthropic', 'claude', { ...usage, outputTokens: -1 })).toBeUndefined();
});
it('retains last good prices on failures, marks them stale, and backs off retries', async () => {
  const f = setup(); await f.cache.refresh();
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
  const f = setup(); await f.cache.refresh(); const initial = f.cache.estimate('anthropic', 'claude', usage);
  f.advance(PRICING_TTL); f.fetcher.mockResolvedValueOnce(Response.json(bad)); await f.cache.refresh();
  expect(f.cache.estimate('anthropic', 'claude', usage)).toEqual({ ...initial, stale: true });
});
it('recovers from corrupt disk state and does not treat zero prices as missing', async () => {
  const f = setup(); writeFileSync(join(f.dir, 'pricing.json'), '{broken');
  const data = catalog(); data.anthropic.models.claude.cost = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  f.fetcher.mockResolvedValueOnce(Response.json(data));
  const cache = new PricingCache(f.dir, f.fetcher, f.now); clean.push(() => cache.dispose());
  await cache.refresh(); expect(cache.estimate('anthropic', 'claude', usage)?.usd).toBe(0);
});
it('shares concurrent refreshes and does not save an in-flight response after disposal', async () => {
  let resolve!: (response: Response) => void;
  const f = setup(vi.fn<typeof fetch>(() => new Promise(r => { resolve = r; })));
  const first = f.cache.refresh(), second = f.cache.refresh(); expect(first).toBe(second);
  f.cache.dispose(); resolve(Response.json(catalog())); await first;
  expect(f.cache.estimate('anthropic', 'claude', usage)).toBeUndefined();
  await f.cache.refresh(); expect(f.fetcher).toHaveBeenCalledTimes(1);
});
it('refreshes in the background after 24 hours and stops its timer on disposal', async () => {
  vi.useFakeTimers();
  const f = setup(); f.cache.start(); await f.cache.refresh();
  f.advance(PRICING_TTL); await vi.advanceTimersByTimeAsync(PRICING_TTL);
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  f.cache.dispose(); f.advance(PRICING_TTL); await vi.advanceTimersByTimeAsync(PRICING_TTL);
  expect(f.fetcher).toHaveBeenCalledTimes(2);
});
