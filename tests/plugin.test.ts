import { Context } from '@deepseek-ai/cordis';
import { expect, it } from 'vitest';
import * as plugin from '../src/index.js';
import { Store } from '../src/store.js';
import { fixture } from './fixtures.js';

it('runs in Cordis, filters subagents, delivers approvals immediately and flushes terminal events once', async () => {
  const f = fixture(false); const ctx = new Context();
  const root = { id: 'root', status: 'running' }, child = { id: 'child', status: 'running' };
  let roots = [root];
  ctx.reflect.provide('sessions', {} as any);
  ctx.reflect.provide('agents', { get: (id: string) => id === 'root' ? root : child, roots: () => roots } as any);
  const fiber = await ctx.plugin(plugin, { dataDir: f.dir });
  try {
    const sessionEvent = (id: string, type: string, data: object) => ctx.emit('session/event', { id } as any, { type, time: Date.now(), data } as any);
    sessionEvent('root', 'turn/start', { turn: 1 });
    sessionEvent('child', 'turn/end', { turn: 1, reason: { kind: 'completed' } });
    sessionEvent('root', 'approval/asked', { id: 'approval', toolName: 'shell' });
    expect(new Store(f.dir).history().map(h => h.notice.kind)).toEqual(['approval']);
    sessionEvent('root', 'turn/end', { turn: 1, reason: { kind: 'completed' } });
    expect(new Store(f.dir).history()).toHaveLength(1);
    root.status = 'idle'; ctx.emit('agent/status', { agent: root, status: 'idle' } as any);
    expect(new Store(f.dir).history().map(h => h.notice.kind)).toEqual(['completed', 'approval']);
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
  } finally { await ctx.fiber.dispose(); f.cleanup(); }
});
