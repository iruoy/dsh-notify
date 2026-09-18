import type { EpochHeader, SessionEvent } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-title';
import type {} from '@deepseek-ai/dsh-user-approval';
import { KINDS, type Kind, type Notice, type RunUsage } from './types.js';
import type { PriceCall } from './pricing.js';

function text(content: readonly unknown[]): string {
  return content.flatMap(block => {
    if (!block || typeof block !== 'object') return [];
    const b = block as { type?: string; text?: unknown };
    return b.type === 'text' && typeof b.text === 'string' ? [b.text] : [];
  }).join('\n');
}
export interface NoticeContext { workspace?: string; config?: EpochHeader['config'] }
/** Incrementally fold committed events, without depending on DSH's removed session.events API. */
export class EventNormalizer {
  private turns = new Map<string, { turn: number; started: number; summary: string; input: string; runs: RunUsage[]; complete: boolean; cost?: Notice['cost'] }>();
  constructor(private priceCall?: PriceCall) {}
  observe(sessionId: string, title: string | undefined, event: SessionEvent, includeSummary: boolean, context: NoticeContext = {}): Notice | undefined {
    if (event.type === 'turn/start') {
      this.turns.set(sessionId, { turn: event.data.turn, started: event.time, summary: '', input: '', runs: [], complete: true,
        ...(this.priceCall ? { cost: { usd: 0, calls: 0, pricedCalls: 0, stale: false } } : {}) }); return;
    }
    const active = this.turns.get(sessionId);
    if (event.type === 'user/message') {
      // Only human input, never injected instructions, tool results, or surface rewrites.
      if (active && event.data.source?.kind === 'user' && event.surfaceOp === 'append') {
        active.input = (active.input + '\n' + text(event.data.content)).trim().slice(0, 1500);
      }
      return;
    }
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      if (!active || active.turn !== event.data.turn) return;
      const config = context.config;
      const source = event.type === 'assistant/message' ? event.data.message.source : config;
      const provider = source?.provider, model = source?.model;
      const effort = config && config.provider === provider && config.model === model ? config.reasoningEffort : undefined;
      if (active.cost) active.cost.calls++;
      if (!provider || !model) active.complete = false;
      else {
        let run = active.runs.find(r => r.provider === provider && r.model === model && r.effort === effort);
        if (!run) {
          run = { provider, model, effort, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, calls: 0, reportedCalls: 0 };
          active.runs.push(run);
        }
        // Attempt streams may contain a final usage snapshot; never sum cumulative snapshots.
        const reported = event.type === 'assistant/message' ? event.data.usage : event.data.stream
          .flatMap(r => r.type === 'chunk' && r.chunk.type === 'usage' ? [r.chunk.usage] : []).at(-1);
        run.calls++;
        if (reported) {
          const estimated = this.priceCall?.(provider, model, reported);
          if (active.cost && estimated) {
            active.cost.usd += estimated.usd;
            active.cost.pricedCalls++;
            active.cost.fetchedAt = Math.min(active.cost.fetchedAt ?? estimated.fetchedAt, estimated.fetchedAt);
            active.cost.stale ||= estimated.stale;
          }
          run.reportedCalls++;
          run.inputTokens += reported.inputTokens;
          run.outputTokens += reported.outputTokens;
          run.cacheReadTokens += reported.cacheReadTokens ?? 0;
          run.cacheWriteTokens += reported.cacheWriteTokens ?? 0;
          // Only the adapter can assert an authoritative full-call total.
          run.totalTokens = run.totalTokens !== undefined && reported.totalTokens !== undefined ? run.totalTokens + reported.totalTokens : undefined;
        } else active.complete = false;
      }
      if (event.type === 'assistant/message' && includeSummary) active.summary = (active.summary + '\n' + text(event.data.message.content)).trim().slice(0, 1500);
      return;
    }
    // Do not send prompts or error/approval details as title fallbacks.
    const base = { sessionId, title: (title || `Session ${sessionId}`).slice(0, 200), time: event.time, ...(context.workspace ? { workspace: context.workspace.slice(0, 1000) } : {}) };
    if (event.type === 'approval/asked') return { ...base, id: `${sessionId}:approval:${event.data.id}`, kind: 'approval', ...(active?.input ? { input: active.input } : {}) };
    if (event.type !== 'turn/end') return;
    this.turns.delete(sessionId);
    const kind = event.data.reason.kind;
    if (!(KINDS as readonly string[]).includes(kind)) return;
    const matched = active?.turn === event.data.turn ? active : undefined;
    return { ...base, id: `${sessionId}:turn:${event.data.turn}`, kind: kind as Kind,
      ...(matched ? { durationMs: Math.max(0, event.time - matched.started), input: matched.input || undefined, runs: matched.runs, usageComplete: matched.complete, ...(matched.cost ? { cost: matched.cost } : {}) } : {}),
      ...(matched?.summary && includeSummary ? { summary: matched.summary } : {}) };
  }
  forget(id: string): void { this.turns.delete(id); }
}
/** DSH appends turn/end before setting idle. Hold terminal notifications until idle. */
export class CompletionGate {
  private pending = new Map<string, Notice[]>();
  enqueue(notice: Notice): void {
    const list = this.pending.get(notice.sessionId) ?? [];
    if (!list.some(n => n.id === notice.id)) list.push(notice);
    this.pending.set(notice.sessionId, list.slice(-20));
  }
  flush(id: string): Notice[] { const list = this.pending.get(id) ?? []; this.pending.delete(id); return list; }
}
