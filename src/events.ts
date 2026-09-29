import type { EpochHeader, SessionEvent } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-title';
import type {} from '@deepseek-ai/dsh-user-approval';
import { KINDS, type Kind, type Notice, type RunUsage } from './types.js';
import type { CallUsage, PriceCall } from './pricing.js';
import { isCount as counter, isTimestamp as timestamp } from './state.js';

function text(content: readonly unknown[]): string {
  return content.flatMap(block => {
    if (!block || typeof block !== 'object') return [];
    const b = block as { type?: string; text?: unknown };
    return b.type === 'text' && typeof b.text === 'string' ? [b.text] : [];
  }).join('\n');
}
export interface NoticeContext { workspace?: string; config?: EpochHeader['config'] }
interface ActiveTurn {
  turn: number; started: number; summary: string; input: string;
  runs: RunUsage[]; complete: boolean; cost?: Notice['cost'];
}
type AssistantEvent = Extract<SessionEvent, { type: 'assistant/message' | 'assistant/attempt' }>;
type NoticeBase = Pick<Notice, 'sessionId' | 'title' | 'time' | 'workspace'>;
function noticeBase(sessionId: string, title: string | undefined, time: number, context: NoticeContext): NoticeBase {
  // Do not send prompts or error/approval details as title fallbacks.
  return { sessionId, title: (title || `Session ${sessionId}`).slice(0, 200), time: timestamp(time) ? time : Date.now(),
    ...(context.workspace ? { workspace: context.workspace.slice(0, 1000) } : {}) };
}
/** Incrementally fold committed events, without depending on DSH's removed session.events API. */
export class EventNormalizer {
  private turns = new Map<string, ActiveTurn>();
  constructor(private priceCall?: PriceCall) {}
  observe(sessionId: string, title: string | undefined, event: SessionEvent, includeSummary: boolean, context: NoticeContext = {}): Notice | undefined {
    switch (event.type) {
      case 'turn/start': this.startTurn(sessionId, event.data.turn, event.time); return;
      case 'user/message': this.appendHumanInput(this.turns.get(sessionId), event); return;
      case 'assistant/message':
      case 'assistant/attempt': this.recordAssistant(this.turns.get(sessionId), event, includeSummary, context); return;
      case 'approval/asked': {
        const active = this.turns.get(sessionId);
        return { ...noticeBase(sessionId, title, event.time, context), id: `${sessionId}:approval:${event.data.id}`, kind: 'approval',
          ...(active?.input ? { input: active.input } : {}) };
      }
      case 'turn/end': return this.finishTurn(noticeBase(sessionId, title, event.time, context), event, includeSummary);
      default: return;
    }
  }
  private startTurn(sessionId: string, turn: number, started: number): void {
    this.turns.set(sessionId, { turn, started, summary: '', input: '', runs: [], complete: true,
      ...(this.priceCall ? { cost: { usd: 0, calls: 0, pricedCalls: 0, stale: false } } : {}) });
  }
  private appendHumanInput(active: ActiveTurn | undefined, event: Extract<SessionEvent, { type: 'user/message' }>): void {
    // Only human input, never injected instructions, tool results, or surface rewrites.
    if (active && event.data.source?.kind === 'user' && event.surfaceOp === 'append') {
      active.input = (active.input + '\n' + text(event.data.content)).trim().slice(0, 1500);
    }
  }
  private recordAssistant(active: ActiveTurn | undefined, event: AssistantEvent, includeSummary: boolean, context: NoticeContext): void {
    if (!active || active.turn !== event.data.turn) return;
    const config = context.config;
    const source = event.type === 'assistant/message' ? event.data.message.source : config;
    const provider = source?.provider, model = source?.model;
    const effort = config && config.provider === provider && config.model === model ? config.reasoningEffort : undefined;
    if (active.cost) active.cost.calls++;
    if (!provider || !model) active.complete = false;
    else {
      const run = this.runFor(active, provider, model, effort);
      // Attempt streams may contain a final usage snapshot; never sum cumulative snapshots.
      const reported = event.type === 'assistant/message' ? event.data.usage : event.data.stream
        .flatMap(r => r.type === 'chunk' && r.chunk.type === 'usage' ? [r.chunk.usage] : []).at(-1);
      run.calls++;
      if (reported) this.recordUsage(active, run, reported);
      else active.complete = false;
    }
    if (event.type === 'assistant/message' && includeSummary) active.summary = (active.summary + '\n' + text(event.data.message.content)).trim().slice(0, 1500);
  }
  private runFor(active: ActiveTurn, provider: string, model: string, effort?: string): RunUsage {
    let run = active.runs.find(r => r.provider === provider && r.model === model && r.effort === effort);
    if (!run) {
      run = { provider, model, effort, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, calls: 0, reportedCalls: 0 };
      active.runs.push(run);
    }
    return run;
  }
  private recordUsage(active: ActiveTurn, run: RunUsage, reported: CallUsage & { totalTokens?: number }): void {
    const inputTokens = run.inputTokens + reported.inputTokens, outputTokens = run.outputTokens + reported.outputTokens;
    const cacheReadTokens = run.cacheReadTokens + (reported.cacheReadTokens ?? 0), cacheWriteTokens = run.cacheWriteTokens + (reported.cacheWriteTokens ?? 0);
    // A null total is as unreported as a missing one; never sum it as zero.
    const reportedTotal = reported.totalTokens ?? undefined;
    const totalTokens = run.totalTokens !== undefined && reportedTotal !== undefined ? run.totalTokens + reportedTotal : undefined;
    // Host usage is untrusted: a counter that persisted state would reject makes the turn's usage incomplete.
    if (![reported.inputTokens, reported.outputTokens, reported.cacheReadTokens ?? 0, reported.cacheWriteTokens ?? 0, reportedTotal ?? 0].every(counter)
      || ![inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens ?? 0].every(counter)) {
      active.complete = false;
      return;
    }
    const estimated = this.priceCall?.(run.provider, run.model, reported);
    // Keep the persisted estimate finite; an unrepresentable sum counts as an unpriced call.
    if (active.cost && estimated && Number.isFinite(active.cost.usd + estimated.usd)) {
      active.cost.usd += estimated.usd;
      active.cost.pricedCalls++;
      active.cost.fetchedAt = Math.min(active.cost.fetchedAt ?? estimated.fetchedAt, estimated.fetchedAt);
      active.cost.stale ||= estimated.stale;
    }
    run.reportedCalls++;
    // Only the adapter can assert an authoritative full-call total.
    Object.assign(run, { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens });
  }
  private finishTurn(base: NoticeBase, event: Extract<SessionEvent, { type: 'turn/end' }>, includeSummary: boolean): Notice | undefined {
    const active = this.turns.get(base.sessionId);
    const matched = active?.turn === event.data.turn ? active : undefined;
    if (matched) this.turns.delete(base.sessionId);
    const kind = event.data.reason.kind;
    if (!(KINDS as readonly string[]).includes(kind)) return;
    return { ...base, id: `${base.sessionId}:turn:${event.data.turn}`, kind: kind as Kind,
      ...(matched ? { ...(timestamp(event.time) && timestamp(matched.started) ? { durationMs: Math.max(0, event.time - matched.started) } : {}), input: matched.input || undefined, runs: matched.runs, usageComplete: matched.complete, ...(matched.cost ? { cost: matched.cost } : {}) } : {}),
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
    this.pending.set(notice.sessionId, list);
  }
  flush(id: string): Notice[] { const list = this.pending.get(id) ?? []; this.pending.delete(id); return list; }
}
