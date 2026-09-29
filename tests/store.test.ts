import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { validateBaseUrl, validateWebhook } from '../src/config.js';
import { KINDS } from '../src/types.js';
import { fixture, notice, WEBHOOK } from './fixtures.js';
const clean: (() => void)[] = [];
function setup() { const f = fixture(); clean.push(f.cleanup); return f; }
afterEach(() => clean.splice(0).forEach(f => f()));
describe('durable state and privacy', () => {
  it('defaults all events on, summaries and destination subagent opt-ins off', () => {
    const { store } = setup();
    for (const k of KINDS) expect(store.view().browser.events[k] && store.view().slack.events[k]).toBe(true);
    expect(store.view()).toMatchObject({ notifySubagents: false, slack: { includeSummary: false, notifySubagents: false } });
  });
  it('persists a private queue, dedupe and sequence across restart', () => {
    const { store, dir } = setup(); store.add({ ...notice(), summary: 'PRIVATE' });
    expect(statSync(join(dir, 'state.json')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, 'state.json'), 'utf8')).not.toContain('PRIVATE');
    const restarted = new Store(dir); expect(restarted.state.queue).toHaveLength(1);
    expect(restarted.add(notice())).toBeUndefined(); expect(restarted.add(notice('next'))?.seq).toBe(2);
    expect(JSON.stringify(store.view())).not.toContain(WEBHOOK);
  });
  it('never returns summaries in history and strips pending summaries on opt-out', () => {
    const { store } = setup(); const settings = store.view(); settings.slack.includeSummary = true;
    store.update({ revision: 1, settings }); store.add({ ...notice(), summary: 'PRIVATE' });
    expect(store.state.queue[0].notice.summary).toBe('PRIVATE'); expect(JSON.stringify(store.history())).not.toContain('PRIVATE');
    settings.slack.includeSummary = false; store.update({ revision: 2, settings });
    expect(JSON.stringify(store.state)).not.toContain('PRIVATE');
  });
  it('cancels legacy and child completions before delivery and persists the migration', () => {
    const { store, dir } = setup();
    for (const id of ['legacy', 'child', 'root', 'failure', 'question', 'delivered']) {
      store.add({ ...notice(id), kind: id === 'failure' ? 'error' : id === 'question' ? 'question' : 'completed' });
    }
    // Simulate persisted work from older releases, including a pending retry.
    store.change(s => {
      for (const item of [...s.queue, ...s.history]) {
        if (item.notice.id !== 'root') delete item.notice.isSubagent;
        if (item.notice.id === 'child') item.notice.isSubagent = true;
      }
      s.queue = s.queue.filter(item => item.notice.id !== 'delivered');
      s.history.find(item => item.notice.id === 'delivered')!.slack = 'delivered';
      const legacy = s.history.find(item => item.notice.id === 'legacy')!;
      legacy.slack = 'retrying'; legacy.nextAttempt = Date.now() + 60_000;
    });
    const restarted = new Store(dir);
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
    expect(new Store(dir).state).toEqual(restarted.state);
  });
  it('cancels queued messages on webhook removal or destination change', () => {
    const { store } = setup(); store.add(notice());
    store.update({ revision: 1, settings: store.view(), webhook: null });
    expect(store.state.queue).toEqual([]); expect(store.history()[0].slack).toBe('cancelled');
  });
  it('rejects stale revisions and invalid values without changing state', () => {
    const { store } = setup();
    expect(() => store.update({ revision: 0, settings: store.view() })).toThrow('another tab');
    expect(() => store.update({ revision: 1, settings: { ...store.view(), notifySubagents: 'yes' } })).toThrow();
    expect(store.view().revision).toBe(1);
  });
  it('bounds the queue and history with an observable overflow', () => {
    const { store } = setup(); for (let i = 0; i < 205; i++) store.add(notice(String(i)));
    expect(store.state.queue).toHaveLength(100); expect(store.state.history).toHaveLength(200); expect(store.history()).toHaveLength(20);
    expect(store.history()[0]).toMatchObject({ slack: 'failed', error: expect.stringContaining('full') });
  });
  it('keeps a successful browser receipt if another device reports failure', () => {
    const { store } = setup(); store.add(notice()); store.ack(1, true); store.ack(1, false);
    expect(store.history()[0].browser).toBe('delivered');
  });
  it('persists browser status transitions once, not every duplicate or downgraded receipt', () => {
    const { store, dir } = setup(); store.add(notice());
    const commits = vi.spyOn(store, 'change');
    store.ack(1, false);
    for (let client = 0; client < 50; client++) store.ack(1, false);
    expect(commits).toHaveBeenCalledTimes(1);
    store.ack(1, true);
    for (let client = 0; client < 50; client++) { store.ack(1, true); store.ack(1, false); }
    expect(commits).toHaveBeenCalledTimes(2);
    expect(new Store(dir).history()[0].browser).toBe('delivered');
    expect(() => store.ack(999, true)).toThrow('Unknown browser delivery');
    expect(commits).toHaveBeenCalledTimes(2);
  });
  it('refuses corrupted state rather than overwriting queued work', () => {
    const { dir } = setup(); writeFileSync(join(dir, 'state.json'), '{broken');
    expect(() => new Store(dir)).toThrow('could not be read');
    expect(readFileSync(join(dir, 'state.json'), 'utf8')).toBe('{broken');
  });
});
describe('URLs', () => {
  it.each(['http://hooks.slack.com/services/A/B/C', 'https://hooks.slack.com.evil.test/services/A/B/C', 'https://u:p@hooks.slack.com/services/A/B/C', 'https://hooks.slack.com/services/A/B/C?secret=1', 'https://127.0.0.1/services/A/B/C'])('rejects %s', value => expect(() => validateWebhook(value)).toThrow());
  it('accepts only clean DSH origins and Slack webhook paths', () => {
    expect(validateWebhook(WEBHOOK)).toBe(WEBHOOK); expect(validateBaseUrl('https://dsh.example.com/')).toBe('https://dsh.example.com');
    expect(validateBaseUrl('http://localhost:3080')).toBe('http://localhost:3080');
    expect(() => validateBaseUrl('https://dsh.example.com/?token=private')).toThrow();
    expect(() => validateBaseUrl('javascript:alert(1)')).toThrow();
  });
});


it('requires a separate Slack subagent opt-in and cancels child work on opt-out', () => {
  const f = fixture();
  try {
    for (const kind of KINDS) expect(f.store.add({ ...notice(`disabled:${kind}`), kind, isSubagent: true, input: 'PRIVATE' })).toBeUndefined();
    expect(f.store.state.queue).toEqual([]);
    const settings = f.store.view();
    settings.slack.notifySubagents = true;
    f.store.update({ revision: settings.revision, settings });
    for (const kind of KINDS) f.store.add({ ...notice(`child:${kind}`), kind, isSubagent: true });
    f.store.add(notice('root:done'));
    expect(f.store.state.queue.map(item => item.notice.kind)).toEqual([...KINDS.filter(k => k !== 'completed'), 'completed']);
    expect(f.store.state.history.filter(item => item.notice.isSubagent).every(item => item.browser === 'disabled')).toBe(true);
    settings.slack.notifySubagents = false;
    f.store.update({ revision: f.store.view().revision, settings });
    expect(f.store.state.queue.map(item => item.notice.id)).toEqual(['root:done']);
    expect(f.store.state.history.filter(item => item.notice.isSubagent).every(item => item.slack === 'cancelled')).toBe(true);
  } finally { f.cleanup(); }
});

it('defaults missing persisted Slack subagent fields to false and cancels legacy child work', () => {
  const f = fixture();
  try {
    const settings = f.store.view(); settings.slack.notifySubagents = true;
    f.store.update({ revision: settings.revision, settings });
    f.store.add({ ...notice('child:error'), kind: 'error', isSubagent: true });
    f.store.add(notice('root:done'));
    const raw = structuredClone(f.store.state);
    delete (raw.settings.slack as Partial<typeof raw.settings.slack>).notifySubagents;
    writeFileSync(join(f.dir, 'state.json'), JSON.stringify(raw));
    const restarted = new Store(f.dir);
    expect(restarted.view().slack.notifySubagents).toBe(false);
    expect(restarted.state.queue.map(item => item.notice.id)).toEqual(['root:done']);
    expect(restarted.state.history[0].slack).toBe('cancelled');
    expect(new Store(f.dir).state).toEqual(restarted.state);
  } finally { f.cleanup(); }
});
