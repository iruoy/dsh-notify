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
