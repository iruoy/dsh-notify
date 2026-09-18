import { LABELS } from './types.js';
export function sessionUrl(baseUrl, sessionId) {
    const url = new URL(baseUrl);
    url.searchParams.set('dsh-notify-session', sessionId);
    return url.href;
}
export function slackPayload(notice, baseUrl) {
    const title = `${LABELS[notice.kind]} · ${notice.title}`;
    const details = [`Session: ${notice.title}`];
    if (notice.durationMs !== undefined)
        details.push(`Duration: ${Math.floor(notice.durationMs / 60000)}m ${Math.floor(notice.durationMs / 1000) % 60}s`);
    const blocks = [
        { type: 'header', text: { type: 'plain_text', text: LABELS[notice.kind], emoji: true } },
        { type: 'section', text: { type: 'plain_text', text: details.join('\n').slice(0, 2900) } },
    ];
    if (notice.summary)
        blocks.push({ type: 'section', text: { type: 'plain_text', text: notice.summary.slice(0, 1500) } });
    if (baseUrl && notice.sessionId)
        blocks.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open in DSH' }, url: sessionUrl(baseUrl, notice.sessionId) }] });
    // Escape Slack's fallback mrkdwn to avoid titles triggering mentions.
    return { text: title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'), blocks, unfurl_links: false, unfurl_media: false };
}
export function retryDelay(header, attempt, now = Date.now()) {
    const seconds = header === null ? NaN : Number(header);
    const date = header === null ? NaN : Date.parse(header);
    const supplied = Number.isFinite(seconds) ? seconds * 1000 : date - now;
    return Number.isFinite(supplied) && supplied >= 0 ? Math.max(1000, supplied) : Math.min(300_000, 1000 * 2 ** attempt);
}
export async function sendSlack(url, payload, attempt, signal, fetcher = fetch) {
    try {
        const response = await fetcher(url, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
            redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        });
        await response.body?.cancel();
        if (response.ok)
            return { ok: true, retry: false };
        const retry = response.status === 429 || response.status >= 500;
        return { ok: false, retry, error: `Slack returned HTTP ${response.status}.`, delay: retryDelay(response.headers.get('retry-after'), attempt) };
    }
    catch {
        // Fetch errors can contain the webhook URL. Never persist or return raw errors.
        return { ok: false, retry: true, error: 'Slack request failed or timed out.', delay: retryDelay(null, attempt) };
    }
}
export class SlackQueue {
    store;
    fetcher;
    busy = false;
    stopped = false;
    controller = new AbortController();
    timer;
    constructor(store, fetcher = fetch) {
        this.store = store;
        this.fetcher = fetcher;
    }
    start() {
        this.timer = setInterval(() => { void this.tick().catch(() => console.warn('[dsh-notify] Queue state could not be saved.')); }, 1000);
        this.timer.unref();
    }
    dispose() { this.stopped = true; clearInterval(this.timer); this.controller.abort(); }
    async tick(now = Date.now()) {
        if (this.stopped || this.busy)
            return;
        const job = this.store.state.queue.find(j => j.nextAttempt <= now);
        if (!job || !this.store.state.webhook || !this.store.state.settings.slack.enabled)
            return;
        this.busy = true;
        const webhook = this.store.state.webhook;
        try {
            const result = await sendSlack(webhook, slackPayload(job.notice, this.store.state.settings.baseUrl), job.attempts, this.controller.signal, this.fetcher);
            if (this.stopped)
                return; // Leave work pending when shutdown aborts an in-flight request.
            this.store.change(s => {
                const pending = s.queue.find(j => j.seq === job.seq);
                if (!pending || s.webhook !== webhook)
                    return;
                pending.attempts++;
                const retry = !result.ok && result.retry && pending.attempts < 6;
                if (retry)
                    pending.nextAttempt = Date.now() + (result.delay ?? 1000);
                else
                    s.queue = s.queue.filter(j => j.seq !== job.seq);
                const h = s.history.find(h => h.seq === job.seq);
                if (h) {
                    h.slack = result.ok ? 'delivered' : retry ? 'retrying' : 'failed';
                    h.attempts = pending.attempts;
                    h.error = result.error;
                    h.nextAttempt = retry ? pending.nextAttempt : undefined;
                }
            });
        }
        finally {
            this.busy = false;
        }
    }
    async test() {
        if (!this.store.state.webhook)
            return { ok: false, retry: false, error: 'Save a Slack webhook first.' };
        return sendSlack(this.store.state.webhook, slackPayload({ id: 'test', kind: 'completed', sessionId: '', title: 'DSH Notify test', time: Date.now() }, ''), 0, this.controller.signal, this.fetcher);
    }
}
