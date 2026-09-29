import { isDeepStrictEqual } from 'node:util';
import { record, validateSettings, validateWebhook } from './config.js';
import { KINDS, type Delivery, type HistoryEntry, type Notice, type RunUsage, type State } from './types.js';

function invalid(): never { throw new Error('Invalid persisted state'); }
function string(value: unknown): string { return typeof value === 'string' ? value : invalid(); }
function boolean(value: unknown): boolean { return typeof value === 'boolean' ? value : invalid(); }
function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : invalid();
}
/** Shared with event normalization so accepted usage always satisfies these persisted-state rules. */
export const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export const isTimestamp = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8.64e15;
function integer(value: unknown): number { return isCount(value) ? value : invalid(); }
function timestamp(value: unknown): number { return isTimestamp(value) ? value : invalid(); }
function optional<T>(value: unknown, parse: (value: unknown) => T): T | undefined { return value === undefined ? undefined : parse(value); }
function array<T>(value: unknown, parse: (value: unknown) => T, max = Infinity): T[] {
  return Array.isArray(value) && value.length <= max ? value.map(parse) : invalid();
}
function run(value: unknown): RunUsage {
  const r = record(value);
  const calls = integer(r.calls), reportedCalls = integer(r.reportedCalls);
  if (reportedCalls > calls) invalid();
  return { provider: string(r.provider), model: string(r.model), effort: optional(r.effort, string),
    inputTokens: integer(r.inputTokens), outputTokens: integer(r.outputTokens),
    cacheReadTokens: integer(r.cacheReadTokens), cacheWriteTokens: integer(r.cacheWriteTokens),
    totalTokens: optional(r.totalTokens, integer), calls, reportedCalls };
}
export function parseNotice(value: unknown): Notice {
  const n = record(value);
  if (!(KINDS as readonly unknown[]).includes(n.kind)) invalid();
  let cost: Notice['cost'];
  if (n.cost !== undefined) {
    const c = record(n.cost), calls = integer(c.calls), pricedCalls = integer(c.pricedCalls);
    if (pricedCalls > calls) invalid();
    cost = { usd: number(c.usd), calls, pricedCalls, fetchedAt: optional(c.fetchedAt, timestamp), stale: boolean(c.stale) };
  }
  return { id: string(n.id), kind: n.kind as Notice['kind'], sessionId: string(n.sessionId), title: string(n.title), time: timestamp(n.time),
    isSubagent: optional(n.isSubagent, boolean), durationMs: optional(n.durationMs, number),
    summary: optional(n.summary, string), workspace: optional(n.workspace, string), input: optional(n.input, string),
    runs: optional(n.runs, v => array(v, run)), usageComplete: optional(n.usageComplete, boolean), cost };
}
function delivery(value: unknown): Delivery {
  return ['disabled', 'waiting', 'delivered', 'retrying', 'failed', 'cancelled'].includes(string(value)) ? value as Delivery : invalid();
}
function history(value: unknown): HistoryEntry {
  const h = record(value);
  return { seq: integer(h.seq), notice: parseNotice(h.notice), browser: delivery(h.browser), slack: delivery(h.slack),
    attempts: integer(h.attempts), nextAttempt: optional(h.nextAttempt, timestamp), error: optional(h.error, string) };
}
function job(value: unknown): State['queue'][number] {
  const j = record(value);
  return { seq: integer(j.seq), notice: parseNotice(j.notice), attempts: integer(j.attempts), nextAttempt: timestamp(j.nextAttempt) };
}
/** Parse all persisted records before migrations can inspect or rewrite them. */
export function parseState(value: unknown): State {
  const s = record(value);
  if (s.version !== 1) invalid();
  const state: State = { version: 1, revision: integer(s.revision), sequence: integer(s.sequence),
    settings: validateSettings(s.settings), webhook: s.webhook === '' ? '' : validateWebhook(s.webhook),
    history: array(s.history, history, 200), queue: array(s.queue, job, 100), seen: array(s.seen, string, 2000) };
  if (new Set(state.seen).size !== state.seen.length) invalid();
  // History fits within the deduplication window, but pending jobs can outlive it.
  if (new Set(state.history.map(entry => entry.notice.id)).size !== state.history.length) invalid();
  for (const entries of [state.history, state.queue]) {
    const sequences = new Set<number>();
    for (const entry of entries) {
      if (!entry.seq || entry.seq > state.sequence || sequences.has(entry.seq)) invalid();
      sequences.add(entry.seq);
    }
  }
  for (let i = 1; i < state.history.length; i++) if (state.history[i - 1].seq >= state.history[i].seq) invalid();
  for (const item of state.queue) {
    const h = state.history.find(entry => entry.seq === item.seq);
    // Queued deliveries may outlive bounded history; only compare retained rows.
    if (!h && (!state.history.length || item.seq >= state.history[0].seq)) invalid();
    if (h && (!isDeepStrictEqual(h.notice, item.notice) || h.attempts !== item.attempts || !['waiting', 'retrying'].includes(h.slack))) invalid();
  }
  return state;
}
