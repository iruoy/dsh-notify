import { Context } from '@deepseek-ai/cordis';
import { expect, it, vi } from 'vitest';
import * as plugin from '../src/index.js';
import { Store } from '../src/store.js';
import { fixture } from './fixtures.js';

it('runs in Cordis, filters subagents, delivers approvals immediately and flushes terminal events once', async () => {
  const f = fixture(false); const ctx = new Context();
  const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Offline test'));
  const root = { id: 'root', status: 'running' }, child = { id: 'child', status: 'running' };
  let roots = [root];
  ctx.reflect.provide('sessions', {} as any);
  ctx.reflect.provide('agents', { get: (id: string) => id === 'root' ? root : child, roots: () => roots } as any);
  const fiber = await ctx.plugin(plugin, { dataDir: f.dir });
  try {
    const sessionEvent = (id: string, type: string, data: object) => ctx.emit('session/event', { id, header: { cwd: '/work/project' }, requestHeader: () => ({ config: { provider: 'p', model: 'm', reasoningEffort: 'high' } }) } as any, { type, time: Date.now(), data, ...(type === 'user/message' ? { surfaceOp: 'append' } : {}) } as any);
    sessionEvent('root', 'turn/start', { turn: 1 });
    sessionEvent('root', 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'Fix the bug' }] });
    sessionEvent('root', 'assistant/message', { turn: 1, step: 1, message: { source: { kind: 'model', provider: 'p', model: 'm' }, content: [] }, usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } });
    sessionEvent('child', 'turn/end', { turn: 1, reason: { kind: 'completed' } });
    sessionEvent('root', 'approval/asked', { id: 'approval', toolName: 'shell' });
    expect(new Store(f.dir).history().map(h => h.notice.kind)).toEqual(['approval']);
    sessionEvent('root', 'turn/end', { turn: 1, reason: { kind: 'completed' } });
    expect(new Store(f.dir).history()).toHaveLength(1);
    root.status = 'idle'; ctx.emit('agent/status', { agent: root, status: 'idle' } as any);
    expect(new Store(f.dir).history().map(h => h.notice.kind)).toEqual(['completed', 'approval']);
    const saved = new Store(f.dir);
    expect(saved.state.history.at(-1)?.notice).toMatchObject({ workspace: '/work/project', input: 'Fix the bug', runs: [{ provider: 'p', model: 'm', effort: 'high', totalTokens: 12 }] });
    expect(saved.history()[0].notice.input).toBeUndefined();
    sessionEvent('root', 'turn/end', { turn: 1, reason: { kind: 'completed' } });
    expect(new Store(f.dir).history()).toHaveLength(2);
    root.status = 'running';
    sessionEvent('root', 'turn/start', { turn: 2 });
    sessionEvent('root', 'turn/end', { turn: 2, reason: { kind: 'error' } });
    roots = [];
    ctx.emit('agent/disposed', { agent: root } as any);
    expect(new Store(f.dir).history()[0].notice.kind).toBe('error');
    await fiber.dispose();
    sessionEvent('root', 'approval/asked', { id: 'after-disposal', toolName: 'shell' });
    expect(new Store(f.dir).history()).toHaveLength(3);
  } finally { await ctx.fiber.dispose(); fetcher.mockRestore(); f.cleanup(); }
});
