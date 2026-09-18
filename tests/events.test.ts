import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { EventNormalizer, CompletionGate } from '../src/events.js';
import { KINDS } from '../src/types.js';
import { notice } from './fixtures.js';
const event = (type: string, data: object, time = 1000) => ({ type, data, time } as SessionEvent);
describe('event interpretation', () => {
  it.each(KINDS.filter(k => k !== 'approval'))('normalizes %s with duration', kind => {
    const normalizer = new EventNormalizer();
    normalizer.observe('s', 'Title', event('turn/start', { turn: 1 }), false);
    expect(normalizer.observe('s', 'Title', event('turn/end', { turn: 1, reason: { kind } }, 6000), false)).toMatchObject({ kind, title: 'Title', durationMs: 5000, id: 's:turn:1' });
  });
  it('emits approval without leaking arguments or reasons', () => {
    const n = new EventNormalizer().observe('s', undefined, event('approval/asked', { id: 'a', toolName: 'shell', reason: 'PRIVATE' }), true);
    expect(n).toMatchObject({ id: 's:approval:a', kind: 'approval', title: 'Session s' });
    expect(JSON.stringify(n)).not.toContain('PRIVATE');
  });
  it('includes only bounded text summaries when opted in', () => {
    const n = new EventNormalizer();
    n.observe('s', '', event('turn/start', { turn: 1 }), true);
    n.observe('s', '', event('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'a'.repeat(2000) }, { type: 'thinking', text: 'private' }] } }), true);
    expect(n.observe('s', '', event('turn/end', { turn: 1, reason: { kind: 'completed' } }), true)?.summary).toBe('a'.repeat(1500));
  });
  it('omits summary on opt-out and duration when attaching mid-turn', () => {
    const n = new EventNormalizer();
    expect(n.observe('s', '', event('turn/end', { turn: 4, reason: { kind: 'interrupted' } }), false)).not.toHaveProperty('durationMs');
    n.observe('s', '', event('turn/start', { turn: 5 }), true);
    n.observe('s', '', event('assistant/message', { turn: 5, message: { content: [{ type: 'text', text: 'private' }] } }), true);
    expect(n.observe('s', '', event('turn/end', { turn: 5, reason: { kind: 'error' } }), false)).not.toHaveProperty('summary');
  });
  it('does not invent an error for unknown future end reasons', () => {
    expect(new EventNormalizer().observe('s', '', event('turn/end', { turn: 1, reason: { kind: 'future' } }), false)).toBeUndefined();
  });
  it('holds and deduplicates terminal records until idle', () => {
    const gate = new CompletionGate(); gate.enqueue(notice()); gate.enqueue(notice());
    expect(gate.flush('other')).toEqual([]); expect(gate.flush('s')).toEqual([notice()]); expect(gate.flush('s')).toEqual([]);
  });
});

const prompt = (value: string, kind = 'user') => ({ ...event('user/message', { source: { kind }, content: [{ type: 'text', text: value }] }), surfaceOp: 'append' } as SessionEvent);
const response = (turn: number, usage?: object, model = 'model-a') => event('assistant/message', {
  turn, step: 1, message: { source: { kind: 'model', provider: 'provider', model }, content: [] }, usage,
});
const context = { workspace: '/work/project', config: { provider: 'provider', model: 'model-a', reasoningEffort: 'high' } };
it('captures human input and aggregates a turn across calls and effort changes', () => {
  const n = new EventNormalizer();
  n.observe('s', '', event('turn/start', { turn: 1 }), false, context);
  n.observe('s', '', prompt('Fix the bug'), false, context);
  n.observe('s', '', prompt('PRIVATE instructions', 'plugin'), false, context);
  n.observe('s', '', { ...prompt('rewritten history'), surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 } } as SessionEvent, false, context);
  n.observe('s', '', prompt('Keep the API'), false, context);
  const usage = { inputTokens: 100, outputTokens: 20, totalTokens: 170, cacheReadTokens: 50, reasoningTokens: 10 };
  n.observe('s', '', response(1, usage), false, context);
  n.observe('s', '', response(1, usage), false, context);
  n.observe('s', '', response(1, usage), false, { ...context, config: { ...context.config, reasoningEffort: 'low' } });
  const result = n.observe('s', '', event('turn/end', { turn: 1, reason: { kind: 'completed' } }), false, context)!;
  expect(result).toMatchObject({ workspace: '/work/project', input: 'Fix the bug\nKeep the API', usageComplete: true });
  expect(result.runs).toEqual([
    { provider: 'provider', model: 'model-a', effort: 'high', inputTokens: 200, outputTokens: 40, cacheReadTokens: 100, cacheWriteTokens: 0, totalTokens: 340, calls: 2, reportedCalls: 2 },
    { provider: 'provider', model: 'model-a', effort: 'low', inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 0, totalTokens: 170, calls: 1, reportedCalls: 1 },
  ]);
  n.observe('s', '', event('turn/start', { turn: 2 }), false, context);
  const next = n.observe('s', '', event('turn/end', { turn: 2, reason: { kind: 'completed' } }), false, context)!;
  expect(next.input).toBeUndefined(); expect(next.runs).toEqual([]);
});
it('keeps accounting isolated by session and turn and preserves missing totals', () => {
  const n = new EventNormalizer();
  n.observe('s', '', event('turn/start', { turn: 1 }), false);
  n.observe('other', '', event('turn/start', { turn: 1 }), false);
  n.observe('s', '', response(2, { inputTokens: 999, outputTokens: 999 }), false, context);
  n.observe('other', '', prompt('Other task'), false);
  n.observe('s', '', response(1, { inputTokens: 10, outputTokens: 2 }), false, context);
  n.observe('s', '', response(1, undefined, 'model-b'), false, context);
  const result = n.observe('s', '', event('turn/end', { turn: 1, reason: { kind: 'error' } }), false)!;
  expect(result.input).toBeUndefined(); expect(result.usageComplete).toBe(false);
  expect(result.runs?.[0]).toMatchObject({ inputTokens: 10, outputTokens: 2, totalTokens: undefined });
  expect(result.runs?.[1]).toMatchObject({ model: 'model-b', effort: undefined, reportedCalls: 0 });
});
it('counts only the final usage snapshot from a failed attempt', () => {
  const n = new EventNormalizer();
  n.observe('s', '', event('turn/start', { turn: 1 }), false);
  n.observe('s', '', event('assistant/attempt', { turn: 1, step: 1, stream: [10, 20].map(inputTokens => ({ type: 'chunk', time: 1, chunk: { type: 'usage', usage: { inputTokens, outputTokens: 0 } } })) }), false, context);
  const result = n.observe('s', '', event('turn/end', { turn: 1, reason: { kind: 'aborted' } }), false)!;
  expect(result.runs?.[0]).toMatchObject({ inputTokens: 20, calls: 1, reportedCalls: 1 });
});
it('bounds input and clears it when an agent is forgotten', () => {
  const n = new EventNormalizer();
  n.observe('s', '', event('turn/start', { turn: 1 }), false);
  n.observe('s', '', prompt('a'.repeat(3000)), false);
  expect(n.observe('s', '', event('approval/asked', { id: 'a' }), false)?.input).toHaveLength(1500);
  n.forget('s');
  expect(n.observe('s', '', event('turn/end', { turn: 1, reason: { kind: 'completed' } }), false)?.input).toBeUndefined();
});
