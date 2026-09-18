import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-title';
import type {} from '@deepseek-ai/dsh-user-approval';
import { KINDS, type Kind, type Notice } from './types.js';

function text(content: readonly unknown[]): string {
  return content.flatMap(block => {
    if (!block || typeof block !== 'object') return [];
    const b = block as { type?: string; text?: unknown };
    return b.type === 'text' && typeof b.text === 'string' ? [b.text] : [];
  }).join('\n');
}
/** Incrementally fold committed events, without depending on DSH's removed session.events API. */
export class EventNormalizer {
  private turns = new Map<string, { turn: number; started: number; summary: string }>();
  observe(sessionId: string, title: string | undefined, event: SessionEvent, includeSummary: boolean): Notice | undefined {
    if (event.type === 'turn/start') {
      this.turns.set(sessionId, { turn: event.data.turn, started: event.time, summary: '' }); return;
    }
    const active = this.turns.get(sessionId);
    if (event.type === 'assistant/message') {
      if (active && active.turn === event.data.turn && includeSummary) active.summary = (active.summary + '\n' + text(event.data.message.content)).trim().slice(0, 1500);
      return;
    }
    // Do not send prompts or error/approval details as title fallbacks.
    const base = { sessionId, title: (title || `Session ${sessionId}`).slice(0, 200), time: event.time };
    if (event.type === 'approval/asked') return { ...base, id: `${sessionId}:approval:${event.data.id}`, kind: 'approval' };
    if (event.type !== 'turn/end') return;
    this.turns.delete(sessionId);
    const kind = event.data.reason.kind;
    if (!(KINDS as readonly string[]).includes(kind)) return;
    const matched = active?.turn === event.data.turn ? active : undefined;
    return { ...base, id: `${sessionId}:turn:${event.data.turn}`, kind: kind as Kind,
      ...(matched ? { durationMs: Math.max(0, event.time - matched.started) } : {}),
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
