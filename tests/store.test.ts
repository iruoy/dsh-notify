import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { SlackQueue } from '../src/webhook.js';
import { validateBaseUrl, validateWebhook } from '../src/config.js';
import { KINDS } from '../src/types.js';
import { fixture, notice, WEBHOOK } from './fixtures.js';
const clean: (() => void)[] = [];
async function setup() { const f = await fixture(); clean.push(f.cleanup); return f; }
afterEach(() => clean.splice(0).forEach(f => f()));
describe('durable state and privacy', async () => {
  it('defaults all events on, summaries and destination subagent opt-ins off', async () => {
    const { store } = await setup();
    for (const k of KINDS) expect(store.view().browser.events[k] && store.view().slack.events[k]).toBe(true);
    expect(store.view()).toMatchObject({ notifySubagents: false, slack: { includeSummary: false, notifySubagents: false } });
  });
  it('persists a private queue, dedupe and sequence across restart', async () => {
    const { store, dir } = await setup(); await store.add({ ...notice(), summary: 'PRIVATE' });
    expect(statSync(join(dir, 'state.json')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, 'state.json'), 'utf8')).not.toContain('PRIVATE');
    const restarted = (await Store.open(dir)); expect(restarted.state.queue).toHaveLength(1);
    expect(await restarted.add(notice())).toBeUndefined(); expect((await restarted.add(notice('next')))?.seq).toBe(2);
    expect(JSON.stringify(store.view())).not.toContain(WEBHOOK);
  });
  it('never returns summaries in history and strips pending summaries on opt-out', async () => {
    const { store } = await setup(); const settings = store.view(); settings.slack.includeSummary = true;
    await store.update({ revision: 1, settings }); await store.add({ ...notice(), summary: 'PRIVATE' });
    expect(store.state.queue[0].notice.summary).toBe('PRIVATE'); expect(JSON.stringify(store.history())).not.toContain('PRIVATE');
    settings.slack.includeSummary = false; await store.update({ revision: 2, settings });
    expect(JSON.stringify(store.state)).not.toContain('PRIVATE');
  });
  it('cancels legacy and child completions before delivery and persists the migration', async () => {
    const { store, dir } = await setup();
    for (const id of ['legacy', 'child', 'root', 'failure', 'question', 'delivered']) {
      await store.add({ ...notice(id), kind: id === 'failure' ? 'error' : id === 'question' ? 'question' : 'completed' });
    }
    // Simulate persisted work from older releases, including a pending retry.
    await store.change(s => {
      for (const item of [...s.queue, ...s.history]) {
        if (item.notice.id !== 'root') delete item.notice.isSubagent;
        if (item.notice.id === 'child') item.notice.isSubagent = true;
      }
      s.queue = s.queue.filter(item => item.notice.id !== 'delivered');
      s.history.find(item => item.notice.id === 'delivered')!.slack = 'delivered';
      const legacy = s.history.find(item => item.notice.id === 'legacy')!;
      legacy.slack = 'retrying'; legacy.nextAttempt = Date.now() + 60_000;
    });
    const restarted = (await Store.open(dir));
    expect(restarted.state.queue.map(item => item.notice.id)).toEqual(['root', 'failure', 'question']);
    for (const id of ['legacy', 'child']) {
      const entry = restarted.state.history.find(item => item.notice.id === id)!;
      expect(entry).toMatchObject({ slack: 'cancelled', browser: 'waiting' });
      expect(entry.nextAttempt).toBeUndefined();
    }
    expect(restarted.state.history.find(item => item.notice.id === 'delivered')?.slack).toBe('delivered');
    expect(restarted.state.seen).toEqual(store.state.seen);
    expect(restarted.state.sequence).toBe(store.state.sequence);
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))).toEqual(restarted.state);
    expect((await Store.open(dir)).state).toEqual(restarted.state);
  });
  it('cancels queued messages on webhook removal or destination change', async () => {
    const { store } = await setup(); await store.add(notice());
    await store.update({ revision: 1, settings: store.view(), webhook: null });
    expect(store.state.queue).toEqual([]); expect(store.history()[0].slack).toBe('cancelled');
  });
  it('rejects stale revisions and invalid values without changing state', async () => {
    const { store } = await setup();
    await expect(store.update({ revision: 0, settings: store.view() })).rejects.toThrow('another tab');
    await expect(store.update({ revision: 1, settings: { ...store.view(), notifySubagents: 'yes' } })).rejects.toThrow();
    expect(store.view().revision).toBe(1);
  });
  it('bounds the queue and history with an observable overflow', async () => {
    const { store } = await setup(); for (let i = 0; i < 205; i++) await store.add(notice(String(i)));
    expect(store.state.queue).toHaveLength(100); expect(store.state.history).toHaveLength(200); expect(store.history()).toHaveLength(20);
    expect(store.history()[0]).toMatchObject({ slack: 'failed', error: expect.stringContaining('full') });
    // Pending jobs older than retained history remain valid on restart.
    expect((await Store.open(store.directory)).state.queue).toHaveLength(100);
  });
  it('restarts with a repeated notice ID after deduplication expires while Slack is retrying', async () => {
    const { store, dir } = await setup();
    const settings = store.view(); settings.slack.events.error = false;
    await store.update({ revision: settings.revision, settings });
    await store.add(notice('pending'));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '86400' } }));
    const queue = new SlackQueue(store, fetcher);
    try { await queue.tick(); } finally { queue.dispose(); }
    const pending = structuredClone(store.state.queue[0]);
    expect(pending.attempts).toBe(1);
    expect(await store.add(notice('pending'))).toBeUndefined();

    for (let i = 0; i < 2000; i += 100) {
      await store.addMany(Array.from({ length: 100 }, (_, j) => ({ ...notice(`newer:${i + j}`), kind: 'error' })));
    }
    expect(store.state.seen).toHaveLength(2000);
    expect(store.state.seen).not.toContain('pending');
    expect(store.state.history.some(entry => entry.seq === pending.seq)).toBe(false);
    const repeated = await store.add(notice('pending'));
    expect(repeated?.seq).toBe(2002);
    expect(store.state.queue.map(item => item.notice.id)).toEqual(['pending', 'pending']);
    await store.close();

    const restarted = await Store.open(dir);
    expect(restarted.state).toEqual(store.state);
    expect(await restarted.add(notice('pending'))).toBeUndefined();
    const delivery = new SlackQueue(restarted, vi.fn<typeof fetch>().mockResolvedValue(new Response('ok')));
    try { await delivery.tick(); } finally { delivery.dispose(); }
    expect(restarted.state.queue).toEqual([pending]);
    expect(restarted.state.history.at(-1)).toMatchObject({ seq: repeated!.seq, slack: 'delivered', attempts: 1 });
    await restarted.close();
    expect((await Store.open(dir)).state).toEqual(restarted.state);
  });
  it('keeps a successful browser receipt if another device reports failure', async () => {
    const { store } = await setup(); await store.add(notice()); await store.ack(1, true); await store.ack(1, false);
    expect(store.history()[0].browser).toBe('delivered');
  });
  it('persists browser status transitions once, not every duplicate or downgraded receipt', async () => {
    const { store, dir } = await setup(); await store.add(notice());
    const commits = vi.spyOn(store as any, 'persist');
    await store.ack(1, false);
    for (let client = 0; client < 50; client++) await store.ack(1, false);
    expect(commits).toHaveBeenCalledTimes(1);
    await store.ack(1, true);
    for (let client = 0; client < 50; client++) { await store.ack(1, true); await store.ack(1, false); }
    expect(commits).toHaveBeenCalledTimes(2);
    expect((await Store.open(dir)).history()[0].browser).toBe('delivered');
    await expect(store.ack(999, true)).rejects.toThrow('Unknown browser delivery');
    expect(commits).toHaveBeenCalledTimes(2);
  });
  it.each([
    ['null queue item', (s: any) => { s.queue[0] = null; }],
    ['missing notice', (s: any) => { delete s.queue[0].notice; }],
    ['invalid kind', (s: any) => { s.queue[0].notice.kind = 'future'; }],
    ['invalid delivery', (s: any) => { s.history[0].slack = 'sent'; }],
    ['unsafe sequence', (s: any) => { s.sequence = Number.MAX_SAFE_INTEGER + 1; }],
    ['negative revision', (s: any) => { s.revision = -1; }],
    ['future queue sequence', (s: any) => { s.queue[0].seq = s.sequence + 1; }],
    ['zero history sequence', (s: any) => { s.history[0].seq = 0; }],
    ['null history entry', (s: any) => { s.history[0] = null; }],
    ['invalid timestamp', (s: any) => { s.history[0].notice.time = 9e15; }],
    ['invalid attempts', (s: any) => { s.queue[0].attempts = -1; }],
    ['missing retry timestamp', (s: any) => { delete s.queue[0].nextAttempt; }],
    ['inconsistent notice', (s: any) => { s.queue[0].notice.id = 'different'; }],
    ['inconsistent status', (s: any) => { s.history[0].slack = 'delivered'; }],
    ['invalid seen id', (s: any) => { s.seen = [null]; }],
    ['duplicate history', (s: any) => { s.history.push(s.history[0]); }],
    ['duplicate history ID', (s: any) => { s.history.push({ ...s.history[0], seq: ++s.sequence }); }],
    ['duplicate queue', (s: any) => { s.queue.push(s.queue[0]); }],
    ['oversized history', (s: any) => { s.history = Array(201).fill(s.history[0]); }],
    ['invalid classification', (s: any) => { s.queue[0].notice.isSubagent = 'false'; }],
    ['invalid usage', (s: any) => { s.history[0].notice.runs = [null]; }],
    ['invalid cost coverage', (s: any) => { s.history[0].notice.cost = { usd: 0, calls: 1, pricedCalls: 2, stale: false }; }],
  ])('refuses parseable malformed state: %s without touching disk', async (_name, corrupt) => {
    const { store, dir } = await setup(); await store.add(notice());
    const raw = JSON.parse(JSON.stringify(store.state)); corrupt(raw);
    const original = JSON.stringify(raw); const path = join(dir, 'state.json');
    writeFileSync(path, original);
    await expect(Store.open(dir)).rejects.toThrow('DSH Notify state could not be read.');
    expect(readFileSync(path, 'utf8')).toBe(original);
  });
  it('refuses corrupted state rather than overwriting queued work', async () => {
    const { dir } = await setup(); writeFileSync(join(dir, 'state.json'), '{broken');
    await expect(Store.open(dir)).rejects.toThrow('could not be read');
    expect(readFileSync(join(dir, 'state.json'), 'utf8')).toBe('{broken');
  });
});
describe('URLs', async () => {
  it.each(['http://hooks.slack.com/services/A/B/C', 'https://hooks.slack.com.evil.test/services/A/B/C', 'https://u:p@hooks.slack.com/services/A/B/C', 'https://hooks.slack.com/services/A/B/C?secret=1', 'https://127.0.0.1/services/A/B/C'])('rejects %s', value => expect(() => validateWebhook(value)).toThrow());
  it('accepts only clean DSH origins and Slack webhook paths', async () => {
    expect(validateWebhook(WEBHOOK)).toBe(WEBHOOK); expect(validateBaseUrl('https://dsh.example.com/')).toBe('https://dsh.example.com');
    expect(validateBaseUrl('http://localhost:3080')).toBe('http://localhost:3080');
    expect(() => validateBaseUrl('https://dsh.example.com/?token=private')).toThrow();
    expect(() => validateBaseUrl('javascript:alert(1)')).toThrow();
  });
});


it('requires a separate Slack subagent opt-in and cancels child work on opt-out', async () => {
  const f = await fixture();
  try {
    for (const kind of KINDS) expect(await f.store.add({ ...notice(`disabled:${kind}`), kind, isSubagent: true, input: 'PRIVATE' })).toBeUndefined();
    expect(f.store.state.queue).toEqual([]);
    const settings = f.store.view();
    settings.slack.notifySubagents = true;
    await f.store.update({ revision: settings.revision, settings });
    for (const kind of KINDS) await f.store.add({ ...notice(`child:${kind}`), kind, isSubagent: true });
    await f.store.add(notice('root:done'));
    expect(f.store.state.queue.map(item => item.notice.kind)).toEqual([...KINDS.filter(k => k !== 'completed'), 'completed']);
    expect(f.store.state.history.filter(item => item.notice.isSubagent).every(item => item.browser === 'disabled')).toBe(true);
    settings.slack.notifySubagents = false;
    await f.store.update({ revision: f.store.view().revision, settings });
    expect(f.store.state.queue.map(item => item.notice.id)).toEqual(['root:done']);
    expect(f.store.state.history.filter(item => item.notice.isSubagent).every(item => item.slack === 'cancelled')).toBe(true);
  } finally { f.cleanup(); }
});

it('defaults missing persisted Slack subagent fields to false and cancels legacy child work', async () => {
  const f = await fixture();
  try {
    const settings = f.store.view(); settings.slack.notifySubagents = true;
    await f.store.update({ revision: settings.revision, settings });
    await f.store.add({ ...notice('child:error'), kind: 'error', isSubagent: true });
    await f.store.add(notice('root:done'));
    const raw = structuredClone(f.store.state);
    delete (raw.settings.slack as Partial<typeof raw.settings.slack>).notifySubagents;
    writeFileSync(join(f.dir, 'state.json'), JSON.stringify(raw));
    const restarted = (await Store.open(f.dir));
    expect(restarted.view().slack.notifySubagents).toBe(false);
    expect(restarted.state.queue.map(item => item.notice.id)).toEqual(['root:done']);
    expect(restarted.state.history[0].slack).toBe('cancelled');
    expect((await Store.open(f.dir)).state).toEqual(restarted.state);
  } finally { f.cleanup(); }
});
