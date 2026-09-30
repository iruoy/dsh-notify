import { afterEach, expect, it } from 'vitest';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { CompletionGate, EventNormalizer } from '../src/events.js';
import { LIMITS } from '../src/limits.js';
import { parseNotice } from '../src/state.js';
import { Store } from '../src/store.js';
import { fixture, notice } from './fixtures.js';

const clean: (() => void)[] = [];
afterEach(() => { for (const fn of clean.splice(0)) fn(); });
const event = (type: string, data: object) => ({ type, data, time: 1000 } as SessionEvent);
it('caps unique routes, rejects oversized route metadata, and reports partial usage and pricing', () => {
  const n = new EventNormalizer(() => ({ usd: 1, fetchedAt: 1000, stale: false }));
  n.observe('s', '', event('turn/start', { turn: 1 }), false);
  const record = (model: string, effort = 'high') => n.observe('s', '', event('assistant/message', {
    turn: 1, message: { source: { provider: 'provider', model }, content: [] }, usage: { inputTokens: 1, outputTokens: 1 },
  }), false, { config: { provider: 'provider', model, reasoningEffort: effort } });
  for (let i = 0; i < LIMITS.runs + 20; i++) record(`model-${i}`);
  record('x'.repeat(LIMITS.route + 1));
  record('model-0', 'x'.repeat(LIMITS.route + 1));
  record('model-0'); // Existing routes still accumulate after overflow.
  const result = n.observe('s', '', event('turn/end', { turn: 1, reason: { kind: 'completed' } }), false)!;
  expect(result.runs).toHaveLength(LIMITS.runs);
  expect(result.runs?.[0].calls).toBe(2);
  expect(result.usageComplete).toBe(false);
  expect(result.cost).toMatchObject({ calls: LIMITS.runs + 23, pricedCalls: LIMITS.runs + 1 });
  expect(() => parseNotice(result)).not.toThrow();
});
it('does not truncate identifiers into collisions', () => {
  const n = new EventNormalizer();
  expect(n.observe('s'.repeat(LIMITS.sessionId + 1), '', event('approval/asked', { id: 'a' }), false)).toBeUndefined();
  expect(n.observe('s', '', event('approval/asked', { id: 'a'.repeat(LIMITS.id) }), false)).toBeUndefined();
});
it('bounds per-session pending terminals, retaining order and deduplication and releasing capacity', () => {
  const gate = new CompletionGate();
  const notices = Array.from({ length: LIMITS.pendingPerSession }, (_, i) => notice(String(i)));
  for (const n of notices) expect(gate.enqueue(n)).toBe(true);
  expect(gate.enqueue(notices[0])).toBe(true);
  expect(gate.enqueue(notice('overflow'))).toBe(false);
  expect(gate.flush('s')).toEqual(notices);
  expect(gate.enqueue(notice('after'))).toBe(true);
  expect(gate.flush('s')).toEqual([notice('after')]);
});
it('bounds pending terminals across sessions without allocating overflow sessions', () => {
  const gate = new CompletionGate();
  for (let i = 0; i < LIMITS.pendingTotal; i++) expect(gate.enqueue({ ...notice(String(i)), sessionId: String(i) })).toBe(true);
  expect(gate.enqueue({ ...notice('overflow'), sessionId: 'overflow' })).toBe(false);
  expect(gate.flush('overflow')).toEqual([]);
  expect(gate.flush('0')).toHaveLength(1);
  expect(gate.enqueue({ ...notice('after'), sessionId: 'after' })).toBe(true);
});
it('rejects oversized persisted fields and runs before serialization, preserving valid peers and restart', async () => {
  const f = await fixture(); clean.push(f.cleanup);
  const run = { provider: 'p', model: 'm', calls: 0, reportedCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const invalid = [
    { ...notice('long-id'), id: 'x'.repeat(LIMITS.id + 1) },
    { ...notice('long-session'), sessionId: 'x'.repeat(LIMITS.sessionId + 1) },
    { ...notice('long-title'), title: 'x'.repeat(LIMITS.title + 1) },
    { ...notice('long-input'), input: 'x'.repeat(LIMITS.text + 1) },
    { ...notice('long-summary'), summary: 'x'.repeat(LIMITS.text + 1) },
    { ...notice('long-workspace'), workspace: 'x'.repeat(LIMITS.workspace + 1) },
    { ...notice('long-runs'), runs: Array(LIMITS.runs + 1).fill(run) },
    { ...notice('long-route'), runs: [{ ...run, provider: 'x'.repeat(LIMITS.route + 1) }] },
  ];
  for (const value of invalid) expect(() => parseNotice(value)).toThrow();
  // Unknown fields must not be traversed or serialized.
  const valid = { ...notice('valid'), extra: { toJSON() { throw new Error('must not serialize'); } } };
  const result = await f.store.addMany([...invalid, valid, notice('last')]);
  expect(result.invalid).toBe(invalid.length);
  expect(result.entries.map(e => e.notice.id)).toEqual(['valid', 'last']);
  expect((await Store.open(f.dir)).state).toEqual(f.store.state);
  const before = f.store.state.sequence;
  await expect(f.store.addMany(Array(LIMITS.batch + 1).fill(notice()))).rejects.toThrow('batch exceeds');
  expect(f.store.state.sequence).toBe(before);
});
