import { afterEach, expect, it, vi } from 'vitest';
import { SlackQueue, retryDelay, sendSlack, sessionUrl, slackPayload } from '../src/webhook.js';
import { fixture, notice, WEBHOOK } from './fixtures.js';
import { Store } from '../src/store.js';
const clean: (() => void)[] = []; afterEach(() => clean.splice(0).forEach(fn => fn()));
function setup(fetcher: typeof fetch) { const f = fixture(); const q = new SlackQueue(f.store, fetcher); clean.push(() => { q.dispose(); f.cleanup(); }); return { ...f, q }; }
it('honors Retry-After seconds/date and exponential fallback', () => {
  expect(retryDelay('120', 0)).toBe(120000);
  expect(retryDelay(new Date(60000).toUTCString(), 0, 0)).toBe(60000);
  expect(retryDelay(null, 3)).toBe(8000);
});
it('uses plain_text and escapes mentions in fallback; link encodes session IDs', () => {
  const payload = slackPayload({ ...notice(), title: '<!channel> & x', summary: '<@U123>' }, 'https://dsh.example.com') as { text: string; blocks: object[] };
  expect(payload.text).toContain('&lt;!channel&gt; &amp; x'); expect(JSON.stringify(payload.blocks)).not.toContain('mrkdwn');
  expect(new URL(sessionUrl('https://dsh.example.com', 'a & /b')).searchParams.get('dsh-notify-session')).toBe('a & /b');
});
it('retries rate limits durably and succeeds after restart', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '60' } })).mockResolvedValue(new Response('ok'));
  const { store, dir, q } = setup(fetcher); store.add(notice()); await q.tick();
  expect(store.history()[0]).toMatchObject({ slack: 'retrying', attempts: 1 }); expect(store.state.queue[0].nextAttempt).toBeGreaterThan(Date.now() + 59000);
  const loaded = new Store(dir); const restarted = new SlackQueue(loaded, fetcher); clean.push(() => restarted.dispose());
  await restarted.tick(Date.now() + 61000); expect(loaded.state.queue).toEqual([]); expect(loaded.history()[0].slack).toBe('delivered');
});
it('does not retry a permanent rejection', async () => {
  const { store, q } = setup(vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 403 })));
  store.add(notice()); await q.tick(); expect(store.history()[0].slack).toBe('failed'); expect(store.state.queue).toEqual([]);
});
it('stops after six transient failures and redacts fetch errors', async () => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error(WEBHOOK)); const { store, q } = setup(fetcher); store.add(notice());
  for (let i = 0; i < 6; i++) await q.tick(Date.now() + 999999);
  expect(fetcher).toHaveBeenCalledTimes(6); expect(store.state.queue).toEqual([]); expect(store.history()[0].slack).toBe('failed');
  expect(JSON.stringify(store.history())).not.toContain(WEBHOOK);
});
it('serializes pumps and ignores results of cancelled destinations', async () => {
  let resolve!: (response: Response) => void;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(r => { resolve = r; }));
  const { store, q } = setup(fetcher); store.add(notice()); const pending = q.tick(); await q.tick(); expect(fetcher).toHaveBeenCalledTimes(1);
  store.update({ revision: 1, settings: store.view(), webhook: null }); resolve(new Response('ok')); await pending;
  expect(store.history()[0].slack).toBe('cancelled');
});
it('refuses redirects and uses a request deadline', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
  await sendSlack(WEBHOOK, {}, 0, new AbortController().signal, fetcher);
  expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) });
});

it('renders workspace, input, model, effort, tokens and partial accounting as plain text', () => {
  const payload = slackPayload({ ...notice(), workspace: '/work/project', input: '<!channel> fix this', usageComplete: false, runs: [
    { provider: 'p', model: 'm', effort: 'high', inputTokens: 1200, outputTokens: 300, cacheReadTokens: 500, cacheWriteTokens: 0, totalTokens: 2000, calls: 2, reportedCalls: 1 },
    { provider: 'p', model: 'other', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1, reportedCalls: 0 },
  ] }, '') as { blocks: object[] };
  const body = JSON.stringify(payload.blocks);
  for (const value of ['Workspace: /work/project', 'Input:', 'Model: p/m', 'Effort: high', '2,000 total', '1,200 input', '300 output', '500 read', 'Tokens: Not reported', 'Effort: Not reported', 'usage is partial']) expect(body).toContain(value);
  expect(body).not.toContain('mrkdwn'); expect(body).not.toContain('Cost:');
});
it('shows estimated costs, partial coverage, stale prices, and unavailable prices explicitly', () => {
  const cost = { usd: 0.02345, calls: 3, pricedCalls: 2, fetchedAt: Date.UTC(2026, 8, 18), stale: true };
  const body = JSON.stringify(slackPayload({ ...notice(), cost }, ''));
  expect(body).toContain('Estimated API cost: ~$0.0234 USD (partial: 2/3 calls priced)');
  expect(body).toContain('Models.dev public list prices · refreshed 2026-09-18 · stale cache');
  expect(JSON.stringify(slackPayload({ ...notice(), cost: { ...cost, usd: 0, pricedCalls: 0 } }, ''))).toContain('Estimated API cost: Unavailable');
  expect(JSON.stringify(slackPayload({ ...notice(), cost: { ...cost, usd: 0.0000001 } }, ''))).toContain('<$0.0001');
});
it('preserves the same estimate across retries and process restarts', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 500 })).mockResolvedValue(new Response('ok'));
  const { store, dir, q } = setup(fetcher);
  const cost = { usd: 0.025, calls: 2, pricedCalls: 2, fetchedAt: 123456789, stale: false };
  store.add({ ...notice(), cost }); await q.tick();
  const loaded = new Store(dir); expect(loaded.state.queue[0].notice.cost).toEqual(cost);
  const restarted = new SlackQueue(loaded, fetcher); clean.push(() => restarted.dispose());
  await restarted.tick(Date.now() + 60000);
  expect(fetcher.mock.calls[1][1]?.body).toBe(fetcher.mock.calls[0][1]?.body);
  expect(loaded.history()[0].notice.cost).toEqual(cost);
});

it.each(['codex', 'claude', 'claude-code'])('labels %s estimates as API equivalents while preserving the actual provider', provider => {
  const body = JSON.stringify(slackPayload({ ...notice(), usageComplete: true, cost: { usd: 0.025, calls: 1, pricedCalls: 1, stale: false }, runs: [
    { provider, model: 'test-model', effort: 'low', inputTokens: 100, outputTokens: 20, cacheReadTokens: 500, cacheWriteTokens: 0, calls: 1, reportedCalls: 1 },
  ] }, ''));
  expect(body).toContain('Estimated API-equivalent cost: ~$0.0250 USD');
  expect(body).toContain(`Model: ${provider}/test-model`);
});
