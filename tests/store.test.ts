import { afterEach, describe, expect, it } from 'vitest';
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
  it('defaults all seven events on, summaries and subagents off', () => {
    const { store } = setup();
    for (const k of KINDS) expect(store.view().browser.events[k] && store.view().slack.events[k]).toBe(true);
    expect(store.view()).toMatchObject({ notifySubagents: false, slack: { includeSummary: false } });
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


it('sends child failures and approvals to Slack but only completes main tasks', () => {
  const f = fixture();
  try {
    f.store.add({ ...notice('child:done'), isSubagent: true });
    f.store.add({ ...notice('child:failed'), kind: 'error', isSubagent: true });
    f.store.add({ ...notice('child:question'), kind: 'approval', isSubagent: true });
    f.store.add(notice('root:done'));
    expect(f.store.state.queue.map(item => item.notice.id)).toEqual(['child:failed', 'child:question', 'root:done']);
    expect(f.store.state.history.filter(item => item.notice.isSubagent).every(item => item.browser === 'disabled')).toBe(true);
  } finally { f.cleanup(); }
});
