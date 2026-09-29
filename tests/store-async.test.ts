import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as persistence from '../src/persistence.js';
import { ConflictError, Store } from '../src/store.js';
import { SlackQueue } from '../src/webhook.js';
import { fixture, notice, WEBHOOK } from './fixtures.js';

const clean: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of clean.splice(0)) await fn(); vi.restoreAllMocks(); });
async function setup() {
  const f = await fixture();
  clean.push(async () => { await f.store.close().catch(() => {}); f.cleanup(); });
  return f;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
function pauseNextWrite() {
  const entered = deferred(), release = deferred();
  const original = persistence.writeJson;
  const writer = vi.spyOn(persistence, 'writeJson').mockImplementationOnce(async (path, value) => {
    entered.resolve();
    await release.promise;
    await original(path, value);
  });
  return { entered, release, writer };
}
it('keeps reads and the event loop available while a durable commit is pending', async () => {
  const f = await setup(); const gate = pauseNextWrite();
  let completed = false;
  const pending = f.store.add(notice()).then(entry => { completed = true; return entry; });
  await gate.entered.promise;
  try {
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(completed).toBe(false);
    expect(f.store.state.sequence).toBe(0);
    expect(f.store.history()).toEqual([]);
    expect(JSON.parse(await readFile(join(f.dir, 'state.json'), 'utf8')).sequence).toBe(0);
  } finally { gate.release.resolve(); }
  expect((await pending)?.seq).toBe(1);
  expect((await Store.open(f.dir)).state.sequence).toBe(1);
});
it('serializes concurrent additions and deduplicates against the latest committed state', async () => {
  const f = await setup();
  const first = Array.from({ length: 40 }, (_, i) => f.store.add(notice(String(i))));
  const duplicates = Array.from({ length: 40 }, (_, i) => f.store.add(notice(String(i))));
  const results = await Promise.all([...first, ...duplicates]);
  expect(results.slice(0, 40).map(entry => entry?.seq)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
  expect(results.slice(40)).toEqual(Array(40).fill(undefined));
  expect(f.store.state.queue).toHaveLength(40);
  expect((await Store.open(f.dir)).state).toEqual(f.store.state);
});
it('checks concurrent settings revisions inside the serialized transaction', async () => {
  const f = await setup(); const settings = f.store.view();
  const results = await Promise.allSettled([
    f.store.update({ revision: settings.revision, settings: { ...settings, baseUrl: 'https://first.example.com' } }),
    f.store.update({ revision: settings.revision, settings: { ...settings, baseUrl: 'https://second.example.com' } }),
  ]);
  expect(results[0].status).toBe('fulfilled');
  expect(results[1]).toMatchObject({ status: 'rejected', reason: expect.any(ConflictError) });
  expect(f.store.view().baseUrl).toBe('https://first.example.com');
  // A validation failure does not poison subsequent valid writes.
  await f.store.add(notice());
  expect((await Store.open(f.dir)).state).toEqual(f.store.state);
});
it('serializes destination changes, additions and receipt transitions without losing updates', async () => {
  const f = await setup(); await f.store.add(notice('first'));
  const settings = f.store.view(); settings.slack.enabled = false;
  await Promise.all([
    f.store.ack(1, true),
    f.store.update({ revision: settings.revision, settings }),
    f.store.add(notice('second')),
    f.store.ack(1, false),
  ]);
  expect(f.store.state.queue).toEqual([]);
  expect(f.store.state.history[0]).toMatchObject({ browser: 'delivered', slack: 'cancelled' });
  expect(f.store.state.history[1]).toMatchObject({ browser: 'waiting', slack: 'disabled' });
  expect((await Store.open(f.dir)).state).toEqual(f.store.state);
});
it('writes one snapshot for concurrent duplicate receipts', async () => {
  const f = await setup(); await f.store.add(notice());
  const writer = vi.spyOn(persistence, 'writeJson');
  await Promise.all(Array.from({ length: 50 }, () => f.store.ack(1, true)));
  expect(writer).toHaveBeenCalledTimes(1);
});
it('fails closed after a persistence error without exposing credentials or publishing uncommitted state', async () => {
  const f = await setup();
  const before = structuredClone(f.store.state);
  const writer = vi.spyOn(persistence, 'writeJson').mockRejectedValueOnce(new Error(WEBHOOK));
  const results = await Promise.allSettled([f.store.add(notice('failed')), f.store.add(notice('queued'))]);
  expect(results.every(result => result.status === 'rejected')).toBe(true);
  expect(results.map(result => result.status === 'rejected' ? result.reason.message : '')).not.toContain(WEBHOOK);
  expect(f.store.state).toEqual(before);
  expect(writer).toHaveBeenCalledTimes(1);
  const fetcher = vi.fn<typeof fetch>(); const queue = new SlackQueue(f.store, fetcher);
  await expect(queue.tick()).rejects.toThrow('Restart');
  expect(fetcher).not.toHaveBeenCalled(); queue.dispose();
  await expect(f.store.close()).rejects.toThrow('Restart');
  expect((await Store.open(f.dir)).state).toEqual(before);
});
it('does not overwrite uncertain disk state after an error following rename', async () => {
  const f = await setup(); const original = persistence.writeJson;
  vi.spyOn(persistence, 'writeJson').mockImplementationOnce(async (path, value) => {
    await original(path, value);
    throw new Error('Simulated directory sync failure after rename');
  });
  await expect(f.store.add(notice('durable-but-unconfirmed'))).rejects.toThrow('could not be saved');
  expect(f.store.state.sequence).toBe(0);
  await expect(f.store.add(notice('must-not-overwrite'))).rejects.toThrow('Restart');
  const restarted = await Store.open(f.dir);
  expect(restarted.state.history.map(h => h.notice.id)).toEqual(['durable-but-unconfirmed']);
});
it('drains accepted writes at shutdown and refuses new mutations', async () => {
  const f = await setup(); const gate = pauseNextWrite();
  const pending = f.store.add(notice()); await gate.entered.promise;
  let closed = false;
  const closing = f.store.close().then(() => { closed = true; });
  try {
    await expect(f.store.add(notice('too-late'))).rejects.toThrow('closed');
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(closed).toBe(false);
  } finally { gate.release.resolve(); }
  await Promise.all([pending, closing]);
  expect((await Store.open(f.dir)).state.history).toHaveLength(1);
});
