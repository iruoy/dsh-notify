import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaults, record, validateSettings, validateWebhook, ValidationError } from './config.js';
import { writeJson } from './persistence.js';
import { parseNotice, parseState } from './state.js';
export class ConflictError extends Error {
}
export class Store {
    directory;
    state;
    tail = Promise.resolve();
    failed = false;
    closed = false;
    constructor(directory, state) {
        this.directory = directory;
        this.state = state;
    }
    static async open(directory, baseUrl = '') {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        let state;
        let fresh = false;
        try {
            state = parseState(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')));
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw new Error('DSH Notify state could not be read. Restore or move state.json before restarting.');
            state = { version: 1, revision: 0, settings: defaults(baseUrl), webhook: '', sequence: 0, history: [], queue: [], seen: [] };
            fresh = true;
        }
        const store = new Store(directory, state);
        if (fresh)
            await store.persist(state);
        // Migrations finish durably before any delivery worker or API can start.
        if (state.queue.some(item => !store.slackAgentAllowed(item.notice))) {
            await store.change(s => {
                s.queue = s.queue.filter(item => {
                    if (store.slackAgentAllowed(item.notice))
                        return true;
                    const history = s.history.find(h => h.seq === item.seq);
                    if (history) {
                        history.slack = 'cancelled';
                        delete history.nextAttempt;
                    }
                    return false;
                });
            });
        }
        return store;
    }
    slackAgentAllowed(notice, slack = this.state.settings.slack) {
        if (notice.kind === 'completed')
            return notice.isSubagent === false;
        return !notice.isSubagent || slack.notifySubagents;
    }
    async persist(next) {
        try {
            await writeJson(join(this.directory, 'state.json'), next);
        }
        catch {
            // A failure after rename can leave disk ahead of memory. Do not overwrite
            // uncertain durable state or send queued work again until a restart.
            this.failed = true;
            throw new Error('DSH Notify state could not be saved. Check the state directory and restart.');
        }
    }
    enqueue(fn) {
        if (this.closed)
            return Promise.reject(new Error('DSH Notify store is closed.'));
        const pending = this.tail.then(() => {
            this.assertHealthy();
            return fn();
        });
        // Validation failures must not poison later transactions; persistence failures
        // do, through assertHealthy. Every caller still receives its own rejection.
        this.tail = pending.then(() => { }, () => { });
        return pending;
    }
    assertHealthy() {
        if (this.failed)
            throw new Error('DSH Notify persistence failed. Restart before continuing delivery.');
    }
    async idle() { await this.tail; this.assertHealthy(); }
    async close() { this.closed = true; await this.idle(); }
    async commit(fn) {
        const next = structuredClone(this.state);
        fn(next);
        await this.persist(next);
        this.state = next;
    }
    change(fn) { return this.enqueue(() => this.commit(fn)); }
    view() { return { ...structuredClone(this.state.settings), revision: this.state.revision, webhookConfigured: Boolean(this.state.webhook) }; }
    update(value) {
        const input = structuredClone(value);
        return this.enqueue(async () => {
            const v = record(input);
            if (v.revision !== this.state.revision)
                throw new ConflictError('Settings changed in another tab. Reload before saving.');
            const settings = validateSettings(v.settings);
            const webhook = v.webhook === undefined ? this.state.webhook : v.webhook === null ? '' : validateWebhook(v.webhook);
            await this.commit(s => {
                s.revision++;
                s.settings = settings;
                // A replaced destination must never receive work queued for the old channel.
                const changed = webhook !== s.webhook;
                s.webhook = webhook;
                s.queue = s.queue.filter(item => {
                    const keep = !changed && !!webhook && settings.slack.enabled && settings.slack.events[item.notice.kind] && this.slackAgentAllowed(item.notice, settings.slack);
                    if (!keep) {
                        const h = s.history.find(h => h.seq === item.seq);
                        if (h) {
                            h.slack = 'cancelled';
                            delete h.nextAttempt;
                        }
                    }
                    else if (!settings.slack.includeSummary)
                        delete item.notice.summary;
                    return keep;
                });
                if (!settings.slack.includeSummary)
                    for (const h of s.history)
                        delete h.notice.summary;
            });
            return this.view();
        });
    }
    add(value) { return this.addMany([value]).then(([entry]) => entry); }
    /** Commit accepted notices in order with one durable snapshot write. */
    addMany(values) {
        let notices;
        // Every committed notice must be reopenable; reject the batch before any mutation.
        try {
            notices = values.map(value => parseNotice(JSON.parse(JSON.stringify(value))));
        }
        catch {
            return Promise.reject(new ValidationError('Invalid notification.'));
        }
        return this.enqueue(async () => {
            const { browser, slack } = this.state.settings, ids = new Set(this.state.seen);
            const accepted = notices.flatMap(notice => {
                if (ids.has(notice.id))
                    return [];
                const toBrowser = browser.enabled && browser.events[notice.kind] && (!notice.isSubagent || this.state.settings.notifySubagents);
                const toSlack = slack.enabled && slack.events[notice.kind] && Boolean(this.state.webhook) && this.slackAgentAllowed({ ...notice, isSubagent: notice.isSubagent ?? false });
                if (!toBrowser && !toSlack)
                    return [];
                ids.add(notice.id);
                return [{ notice, toBrowser, toSlack }];
            });
            if (!accepted.length)
                return [];
            const entries = [];
            await this.commit(s => {
                for (const { notice, toBrowser, toSlack } of accepted) {
                    // Persist the default explicitly so new main-task notices survive restart.
                    notice.isSubagent ??= false;
                    if (!s.settings.slack.includeSummary)
                        delete notice.summary;
                    const entry = { seq: ++s.sequence, notice, browser: toBrowser ? 'waiting' : 'disabled', slack: toSlack ? 'waiting' : 'disabled', attempts: 0 };
                    entries.push(entry);
                    s.seen.push(notice.id);
                    s.history.push(entry);
                    if (toSlack) {
                        if (s.queue.length >= 100) {
                            entry.slack = 'failed';
                            entry.error = 'Slack queue is full (100 pending deliveries).';
                        }
                        else
                            s.queue.push({ seq: entry.seq, notice, attempts: 0, nextAttempt: Date.now() });
                    }
                }
                s.seen = s.seen.slice(-2000);
                s.history = s.history.slice(-200);
            });
            return entries;
        });
    }
    ack(seq, delivered) {
        return this.enqueue(async () => {
            const entry = this.state.history.find(h => h.seq === seq && h.browser !== 'disabled');
            if (!Number.isSafeInteger(seq) || !entry)
                throw new ValidationError('Unknown browser delivery.');
            const status = delivered ? 'delivered' : 'failed';
            if (entry.browser === 'delivered' || entry.browser === status)
                return;
            await this.commit(s => { s.history.find(h => h.seq === seq).browser = status; });
        });
    }
    history() {
        // Response summaries never enter browser API responses, even if opted in for Slack.
        return this.state.history.slice(-20).reverse().map(h => ({ ...h, notice: { ...h.notice, summary: undefined, input: undefined } }));
    }
}
