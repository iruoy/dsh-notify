import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerApi, type WebServer } from '../src/api.js';
import { BrowserStream } from '../src/browser.js';
import { SlackQueue } from '../src/webhook.js';
import { fixture, notice, WEBHOOK } from './fixtures.js';
class ResponseMock extends EventEmitter {
  status = 0; output = ''; headersSent = false; destroyed = false;
  writeHead(status: number) { this.status = status; this.headersSent = true; return this; }
  setHeader() {} flushHeaders() {}
  write(value: string) { this.output += value; return true; }
  end(value = '') { this.output += value; this.emit('close'); }
  destroy() { this.destroyed = true; this.emit('close'); }
}
const clean: (() => void)[] = []; afterEach(() => clean.splice(0).forEach(fn => fn()));
function setup(rejected?: 401 | 403) {
  const f = fixture(); const stream = new BrowserStream(f.store); const queue = new SlackQueue(f.store, vi.fn<typeof fetch>().mockResolvedValue(new Response('ok')));
  const routes = new Map<string, Parameters<WebServer['register']>[0]['handler']>();
  const rejection = vi.fn(() => rejected);
  const dispose = registerApi({ register: r => { routes.set(r.path, r.handler); return () => routes.delete(r.path); } }, { requestRejection: rejection }, f.store, stream, queue);
  clean.push(() => { dispose(); queue.dispose(); f.cleanup(); });
  const request = async (path: string, method = 'GET', data?: unknown, headers: Record<string, string> = {}) => {
    const req = Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]) as IncomingMessage;
    req.method = method; req.url = '/api/dsh-notify' + path; req.headers = { 'content-type': 'application/json', 'x-dsh-notify': '1', ...headers };
    const res = new ResponseMock(); await routes.get(req.url.split('?')[0])!(req, res as unknown as ServerResponse); return res;
  };
  return { ...f, stream, request, rejection, routes, dispose };
}
describe('protected settings and SSE API', () => {
  it.each([401, 403] as const)('enforces DSH authentication on every endpoint (%s)', async status => {
    const s = setup(status);
    for (const path of ['/settings', '/history', '/events', '/ack', '/test-slack']) expect((await s.request(path)).status).toBe(status);
    expect(s.rejection).toHaveBeenCalledTimes(5);
  });
  it('redacts secrets on reads, writes and validation failures', async () => {
    const s = setup(); const get = await s.request('/settings'); expect(get.status).toBe(200); expect(get.output).not.toContain(WEBHOOK);
    const invalid = await s.request('/settings', 'PUT', { revision: 1, settings: s.store.view(), webhook: WEBHOOK + '?x=SECRET' });
    expect(invalid.status).toBe(400); expect(invalid.output).not.toContain('SECRET');
    const put = await s.request('/settings', 'PUT', { revision: 1, settings: s.store.view(), webhook: WEBHOOK });
    expect(put.status).toBe(200); expect(put.output).not.toContain(WEBHOOK);
  });
  it('rejects cross-origin simple mutations and stale settings', async () => {
    const s = setup(); const data = { revision: 0, settings: s.store.view() };
    expect((await s.request('/settings', 'PUT', data, { 'x-dsh-notify': '' })).status).toBe(403);
    expect((await s.request('/settings', 'PUT', data)).status).toBe(409);
    expect((await s.request('/settings', 'POST', data)).status).toBe(405);
  });
  it('starts fresh streams at now and replays only after Last-Event-ID', async () => {
    const s = setup(); s.store.add(notice('1')); s.store.add(notice('2'));
    const fresh = await s.request('/events'); expect(fresh.output).not.toContain('event: notice'); expect(fresh.output).toContain('id: 2');
    const reconnect = await s.request('/events?after=0', 'GET', undefined, { 'last-event-id': '1' });
    expect(reconnect.output).toContain('"id":"2"'); expect(reconnect.output).not.toContain('"id":"1"');
    const next = s.store.add(notice('3'))!; s.stream.publish(next); expect(fresh.output).toContain('"id":"3"');
    s.dispose(); expect(s.routes.size).toBe(0);
  });
  it('respects disabled browser event policy during replay', async () => {
    const s = setup(); s.store.add(notice()); const settings = s.store.view(); settings.browser.events.completed = false;
    s.store.update({ revision: 1, settings });
    expect((await s.request('/events?after=0')).output).not.toContain('event: notice');
  });
  it('validates stream cursors and records real browser receipts', async () => {
    const s = setup(); expect((await s.request('/events?after=not-a-number')).status).toBe(400);
    s.store.add(notice()); expect((await s.request('/ack', 'POST', { seq: 1, delivered: true })).status).toBe(200);
    expect(s.store.history()[0].browser).toBe('delivered');
  });
  it('returns a Slack test result and rate limits repeated tests', async () => {
    const s = setup(); expect((await s.request('/test-slack', 'POST')).status).toBe(200);
    expect((await s.request('/test-slack', 'POST')).status).toBe(429);
  });
});

it('does not discard a normal replay burst when Node reports backpressure', () => {
  const f = fixture(false); const stream = new BrowserStream(f.store);
  try {
    for (let i = 0; i < 100; i++) f.store.add(notice(String(i)));
    const res = new ResponseMock();
    res.write = (value: string) => { res.output += value; return false; };
    stream.connect(res as unknown as ServerResponse, 0);
    expect(res.destroyed).toBe(false);
    expect(res.output).toContain('"id":"99"');
  } finally { stream.dispose(); f.cleanup(); }
});
