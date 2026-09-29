import { LABELS, type Notice } from './types.js';
import { publicPricingProvider } from './pricing.js';
import type { Store } from './store.js';

export function sessionUrl(baseUrl: string, sessionId: string): string {
  const url = new URL(baseUrl); url.searchParams.set('dsh-notify-session', sessionId); return url.href;
}
function costDetail(notice: Notice): string | undefined {
  const cost = notice.cost;
  if (!cost) return;
  const label = notice.runs?.some(run => publicPricingProvider(run.provider) !== run.provider) ? 'Estimated API-equivalent cost' : 'Estimated API cost';
  if (!cost.pricedCalls) return `${label}: Unavailable`;
  const value = cost.usd > 0 && cost.usd < 0.0001 ? '<$0.0001' : `~$${cost.usd.toFixed(4)}`;
  const coverage = cost.pricedCalls < cost.calls ? ` (partial: ${cost.pricedCalls}/${cost.calls} calls priced)` : '';
  return `${label}: ${value} USD${coverage}`;
}
function runBlocks(notice: Notice): object[] {
  if (!notice.runs?.length) return [];
  const count = (n: number): string => n.toLocaleString('en-US');
  const runs = notice.runs.slice(0, 40).map(run => {
    const lines = [`Model: ${run.provider}/${run.model}`, `Effort: ${run.effort ?? 'Not reported'}`];
    if (run.reportedCalls) {
      const total = run.totalTokens === undefined ? '' : `${count(run.totalTokens)} total · `;
      lines.push(`Tokens: ${total}${count(run.inputTokens)} input · ${count(run.outputTokens)} output`);
      if (run.cacheReadTokens || run.cacheWriteTokens) lines.push(`Cache: ${count(run.cacheReadTokens)} read · ${count(run.cacheWriteTokens)} write`);
    } else lines.push('Tokens: Not reported');
    return lines.join('\n');
  });
  // Keep each section within Slack's limits, including unusually long route names.
  const blocks: object[] = runs.map(run => ({ type: 'section', text: { type: 'plain_text', text: run.slice(0, 2900) } }));
  if (notice.runs.length > 40) blocks.push({ type: 'section', text: { type: 'plain_text', text: `${notice.runs.length - 40} additional model/effort combinations omitted.` } });
  if (!notice.usageComplete) blocks.push({ type: 'context', elements: [{ type: 'plain_text', text: 'Token usage is partial; some calls did not report usage.' }] });
  return blocks;
}
export function slackPayload(notice: Notice, baseUrl: string): object {
  const title = `${LABELS[notice.kind]} · ${notice.title}`;
  const details = [`Session: ${notice.title}`];
  if (notice.workspace) details.push(`Workspace: ${notice.workspace}`);
  if (notice.durationMs !== undefined) details.push(`Duration: ${Math.floor(notice.durationMs / 60000)}m ${Math.floor(notice.durationMs / 1000) % 60}s`);
  const cost = costDetail(notice);
  if (cost) details.push(cost);
  const blocks: object[] = [
    { type: 'header', text: { type: 'plain_text', text: LABELS[notice.kind], emoji: true } },
    { type: 'section', text: { type: 'plain_text', text: details.join('\n').slice(0, 2900) } },
  ];
  if (notice.input) blocks.push({ type: 'section', text: { type: 'plain_text', text: `Input:\n${notice.input.slice(0, 1500)}` } });
  blocks.push(...runBlocks(notice));
  if (notice.summary) blocks.push({ type: 'section', text: { type: 'plain_text', text: notice.summary.slice(0, 1500) } });
  if (notice.cost?.pricedCalls && notice.cost.fetchedAt !== undefined) blocks.push({ type: 'context', elements: [{ type: 'plain_text', text: `Models.dev public list prices · refreshed ${new Date(notice.cost.fetchedAt).toISOString().slice(0, 10)}${notice.cost.stale ? ' · stale cache' : ''}` }] });
  if (baseUrl && notice.sessionId) blocks.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open in DSH' }, url: sessionUrl(baseUrl, notice.sessionId) }] });
  // Escape Slack's fallback mrkdwn to avoid titles triggering mentions.
  return { text: title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'), blocks, unfurl_links: false, unfurl_media: false };
}
// Bound server-supplied delays so the persisted retry time always stays a valid timestamp.
const MAX_RETRY_DELAY = 24 * 60 * 60 * 1000;
export function retryDelay(header: string | null, attempt: number, now = Date.now()): number {
  const seconds = header === null ? NaN : Number(header);
  const date = header === null ? NaN : Date.parse(header);
  const supplied = Number.isFinite(seconds) ? seconds * 1000 : date - now;
  return Number.isFinite(supplied) && supplied >= 0 ? Math.min(MAX_RETRY_DELAY, Math.max(1000, supplied)) : Math.min(300_000, 1000 * 2 ** attempt);
}
export interface SendResult { ok: boolean; retry: boolean; error?: string; delay?: number }
export async function sendSlack(url: string, payload: object, attempt: number, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<SendResult> {
  try {
    const response = await fetcher(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    await response.body?.cancel();
    if (response.ok) return { ok: true, retry: false };
    const retry = response.status === 429 || response.status >= 500;
    return { ok: false, retry, error: `Slack returned HTTP ${response.status}.`, delay: retryDelay(response.headers.get('retry-after'), attempt) };
  } catch {
    // Fetch errors can contain the webhook URL. Never persist or return raw errors.
    return { ok: false, retry: true, error: 'Slack request failed or timed out.', delay: retryDelay(null, attempt) };
  }
}
export class SlackQueue {
  private busy = false;
  private stopped = false;
  private controller = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  constructor(private store: Store, private fetcher: typeof fetch = fetch) {}
  start(): void {
    this.timer = setInterval(() => { void this.tick().catch(() => console.warn('[dsh-notify] Queue state could not be saved.')); }, 1000);
    this.timer.unref();
  }
  dispose(): void { this.stopped = true; clearInterval(this.timer); this.controller.abort(); }
  async tick(now = Date.now()): Promise<void> {
    if (this.stopped || this.busy) return;
    this.busy = true;
    try {
      await this.store.idle();
      if (this.stopped) return;
      const job = this.store.state.queue.find(j => j.nextAttempt <= now);
      if (!job || !this.store.state.webhook || !this.store.state.settings.slack.enabled) return;
      const webhook = this.store.state.webhook;
      const result = await sendSlack(webhook, slackPayload(job.notice, this.store.state.settings.baseUrl), job.attempts, this.controller.signal, this.fetcher);
      if (this.stopped) return; // Leave work pending when shutdown aborts an in-flight request.
      await this.store.change(s => {
        const pending = s.queue.find(j => j.seq === job.seq);
        if (!pending || s.webhook !== webhook) return;
        pending.attempts++;
        const retry = !result.ok && result.retry && pending.attempts < 6;
        if (retry) pending.nextAttempt = Date.now() + (result.delay ?? 1000);
        else s.queue = s.queue.filter(j => j.seq !== job.seq);
        const h = s.history.find(h => h.seq === job.seq);
        if (h) {
          h.slack = result.ok ? 'delivered' : retry ? 'retrying' : 'failed';
          h.attempts = pending.attempts; h.error = result.error;
          h.nextAttempt = retry ? pending.nextAttempt : undefined;
        }
      });
    } finally { this.busy = false; }
  }
  async test(): Promise<SendResult> {
    await this.store.idle();
    if (!this.store.state.webhook) return { ok: false, retry: false, error: 'Save a Slack webhook first.' };
    return sendSlack(this.store.state.webhook, slackPayload({ id: 'test', kind: 'completed', sessionId: '', title: 'DSH Notify test', time: Date.now() }, ''), 0, this.controller.signal, this.fetcher);
  }
}
