import { mkdirSync, readFileSync, renameSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaults, record, validateSettings, validateWebhook, ValidationError } from './config.js';
import type { HistoryEntry, Notice, SettingsView, State } from './types.js';

export class ConflictError extends Error {}
export class Store {
  state: State;
  private path: string;
  constructor(readonly directory: string, baseUrl = '') {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, 'state.json');
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as State;
      if (raw.version !== 1 || !Array.isArray(raw.history) || !Array.isArray(raw.queue) || !Array.isArray(raw.seen) || !Number.isSafeInteger(raw.sequence) || !Number.isSafeInteger(raw.revision)) throw new Error('Unsupported state');
      this.state = { ...raw, settings: validateSettings(raw.settings), webhook: raw.webhook ? validateWebhook(raw.webhook) : '' };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('DSH Notify state could not be read. Restore or move state.json before restarting.');
      this.state = { version: 1, revision: 0, settings: defaults(baseUrl), webhook: '', sequence: 0, history: [], queue: [], seen: [] };
      this.persist();
    }
  }
  /** Commit a complete snapshot, fsync before rename; the secret is never a separate partial write. */
  private persist(next = this.state): void {
    const temp = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
    const fd = openSync(temp, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, this.path);
    const dir = openSync(this.directory, 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  }
  change(fn: (state: State) => void): void {
    const next = structuredClone(this.state); fn(next); this.persist(next); this.state = next;
  }
  view(): SettingsView { return { ...structuredClone(this.state.settings), revision: this.state.revision, webhookConfigured: Boolean(this.state.webhook) }; }
  update(value: unknown): SettingsView {
    const input = record(value);
    if (input.revision !== this.state.revision) throw new ConflictError('Settings changed in another tab. Reload before saving.');
    const settings = validateSettings(input.settings);
    const webhook = input.webhook === undefined ? this.state.webhook : input.webhook === null ? '' : validateWebhook(input.webhook);
    this.change(s => {
      s.revision++; s.settings = settings;
      // A replaced destination must never receive work queued for the old channel.
      const changed = webhook !== s.webhook;
      s.webhook = webhook;
      s.queue = s.queue.filter(item => {
        const keep = !changed && !!webhook && settings.slack.enabled && settings.slack.events[item.notice.kind];
        if (!keep) { const h = s.history.find(h => h.seq === item.seq); if (h) { h.slack = 'cancelled'; delete h.nextAttempt; } }
        else if (!settings.slack.includeSummary) delete item.notice.summary;
        return keep;
      });
      if (!settings.slack.includeSummary) for (const h of s.history) delete h.notice.summary;
    });
    return this.view();
  }
  add(notice: Notice): HistoryEntry | undefined {
    if (this.state.seen.includes(notice.id)) return;
    const { browser, slack } = this.state.settings;
    const toBrowser = browser.enabled && browser.events[notice.kind];
    const toSlack = slack.enabled && slack.events[notice.kind] && Boolean(this.state.webhook);
    if (!toBrowser && !toSlack) return;
    let entry: HistoryEntry | undefined;
    this.change(s => {
      const safe = structuredClone(notice);
      if (!s.settings.slack.includeSummary) delete safe.summary;
      entry = { seq: ++s.sequence, notice: safe, browser: toBrowser ? 'waiting' : 'disabled', slack: toSlack ? 'waiting' : 'disabled', attempts: 0 };
      s.seen = [...s.seen, notice.id].slice(-2000);
      s.history = [...s.history, entry].slice(-200);
      if (toSlack) {
        if (s.queue.length >= 100) { entry.slack = 'failed'; entry.error = 'Slack queue is full (100 pending deliveries).'; }
        else s.queue.push({ seq: entry.seq, notice: safe, attempts: 0, nextAttempt: Date.now() });
      }
    });
    return entry;
  }
  ack(seq: number, delivered: boolean): void {
    if (!Number.isSafeInteger(seq) || !this.state.history.some(h => h.seq === seq && h.browser !== 'disabled')) throw new ValidationError('Unknown browser delivery.');
    this.change(s => { const h = s.history.find(h => h.seq === seq)!; if (h.browser !== 'delivered') h.browser = delivered ? 'delivered' : 'failed'; });
  }
  history(): HistoryEntry[] {
    // Response summaries never enter browser API responses, even if opted in for Slack.
    return this.state.history.slice(-20).reverse().map(h => ({ ...h, notice: { ...h.notice, summary: undefined, input: undefined } }));
  }
}
