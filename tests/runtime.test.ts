import { afterEach, expect, it, vi } from 'vitest';
import { BrowserRuntime } from '../src/client/runtime.js';
import { notice } from './fixtures.js';

class Source {
  static instances: Source[] = [];
  handlers = new Map<string, (event: { data: string }) => void>();
  closed = false;
  onopen?: () => void;
  onerror?: () => void;
  constructor(readonly url: string) { Source.instances.push(this); }
  addEventListener(type: string, fn: (event: { data: string }) => void) { this.handlers.set(type, fn); }
  emit(type: string, data: unknown) { this.handlers.get(type)?.({ data: JSON.stringify(data) }); }
  close() { this.closed = true; }
}
const clean: (() => void)[] = [];
afterEach(() => { clean.splice(0).forEach(fn => fn()); vi.unstubAllGlobals(); vi.useRealTimers(); });
function setup(storageFails = false) {
  Source.instances = [];
  const values = new Map([['dsh-notify:cursor:v1', '0']]);
  const show = vi.fn();
  class NotificationMock {
    static permission = 'granted';
    constructor() { show(); }
  }
  vi.stubGlobal('Notification', NotificationMock);
  vi.stubGlobal('window', { Notification: NotificationMock, isSecureContext: true, addEventListener() {}, removeEventListener() {} });
  const leadership = vi.fn(async (_name, _options, fn) => fn());
  vi.stubGlobal('navigator', { locks: { request: leadership } });
  vi.stubGlobal('EventSource', Source);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => { if (storageFails) throw new Error('Unavailable'); return values.get(key) ?? null; },
    setItem: (key: string, value: string) => { if (storageFails) throw new Error('Unavailable'); values.set(key, value); },
  });
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ ok: true })));
  vi.stubGlobal('fetch', fetcher);
  const runtime = new BrowserRuntime(() => {});
  clean.push(() => runtime.dispose());
  runtime.start();
  return { runtime, values, show, fetcher, leadership, NotificationMock, source: Source.instances[0] };
}
it('pauses on display failure, ignores queued notices/cursors, and replays from the unchanged cursor on focus', async () => {
  const s = setup(); s.show.mockImplementationOnce(() => { throw new Error('Display failed'); });
  s.source.emit('notice', { seq: 1, notice: notice('failed') });
  s.source.emit('notice', { seq: 2, notice: notice('later') });
  s.source.emit('cursor', 2);
  expect(s.source.closed).toBe(true);
  expect(s.values.get('dsh-notify:cursor:v1')).toBe('0');
  expect(s.show).toHaveBeenCalledTimes(1);
  expect(JSON.parse(s.fetcher.mock.calls[0][1]!.body as string)).toEqual({ seq: 1, delivered: false });
  s.runtime.refresh();
  expect(s.leadership).toHaveBeenCalledTimes(1);
  const recovered = Source.instances[1];
  expect(recovered.url).toBe('/api/dsh-notify/events?after=0');
  s.source.emit('cursor', 9); // Stale callbacks must not overwrite the recovered stream.
  recovered.emit('notice', { seq: 1, notice: notice('failed') });
  recovered.emit('notice', { seq: 2, notice: notice('later') });
  recovered.emit('notice', { seq: 2, notice: notice('duplicate') });
  expect(s.show).toHaveBeenCalledTimes(3);
  expect(s.values.get('dsh-notify:cursor:v1')).toBe('2');
  await vi.waitFor(() => expect(s.fetcher).toHaveBeenCalledTimes(3));
});
it('retains an in-memory cursor when localStorage is unavailable', () => {
  const s = setup(true);
  s.source.emit('cursor', 4);
  s.show.mockImplementationOnce(() => { throw new Error('Display failed'); });
  s.source.emit('notice', { seq: 5, notice: notice() });
  s.runtime.refresh();
  expect(Source.instances[1].url).toBe('/api/dsh-notify/events?after=4');
});
it('retries successful receipts without redisplaying and stops retries on disposal', async () => {
  vi.useFakeTimers();
  const s = setup();
  s.fetcher.mockRejectedValueOnce(new Error('Offline'));
  s.source.emit('notice', { seq: 1, notice: notice() });
  await vi.advanceTimersByTimeAsync(0);
  expect(s.values.get('dsh-notify:cursor:v1')).toBe('1');
  await vi.advanceTimersByTimeAsync(5000);
  expect(s.fetcher).toHaveBeenCalledTimes(2);
  s.source.emit('notice', { seq: 1, notice: notice() });
  expect(s.show).toHaveBeenCalledTimes(1);
  expect(JSON.parse(s.fetcher.mock.calls[1][1]!.body as string)).toEqual({ seq: 1, delivered: true });
  s.fetcher.mockRejectedValue(new Error('Offline'));
  s.source.emit('notice', { seq: 2, notice: notice('second') });
  await vi.advanceTimersByTimeAsync(0);
  s.runtime.dispose();
  await vi.advanceTimersByTimeAsync(10000);
  expect(s.fetcher).toHaveBeenCalledTimes(3);
});
it('retires receipts outside server history rather than retrying permanent validation failures', async () => {
  vi.useFakeTimers();
  const s = setup();
  s.fetcher.mockResolvedValue(new Response(JSON.stringify({ error: 'Unknown browser delivery.' }), { status: 400 }));
  s.source.emit('notice', { seq: 1, notice: notice() });
  await vi.advanceTimersByTimeAsync(15000);
  s.runtime.refresh();
  expect(s.fetcher).toHaveBeenCalledTimes(1);
  expect(s.show).toHaveBeenCalledTimes(1);
});
it('bounds offline receipt retries to the server history window', async () => {
  vi.useFakeTimers();
  const s = setup(); s.fetcher.mockRejectedValue(new Error('Offline'));
  for (let seq = 1; seq <= 250; seq++) s.source.emit('notice', { seq, notice: notice(String(seq)) });
  await vi.advanceTimersByTimeAsync(0);
  s.fetcher.mockClear();
  await vi.advanceTimersByTimeAsync(5000);
  expect(s.fetcher).toHaveBeenCalledTimes(200);
  const receipts = s.fetcher.mock.calls.map(([, options]) => JSON.parse(options!.body as string).seq);
  expect(receipts).toEqual(Array.from({ length: 200 }, (_, i) => i + 51));
  expect(s.show).toHaveBeenCalledTimes(250);
});
it('keeps display-recovery instructions visible when an earlier receipt retry fails', async () => {
  vi.useFakeTimers();
  const s = setup(); s.fetcher.mockRejectedValue(new Error('Offline'));
  s.source.emit('notice', { seq: 1, notice: notice() });
  s.show.mockImplementationOnce(() => { throw new Error('Display failed'); });
  s.source.emit('notice', { seq: 2, notice: notice('failed') });
  await vi.advanceTimersByTimeAsync(5000);
  expect(s.runtime.snapshot()).toContain('focus this tab to retry');
  expect(s.values.get('dsh-notify:cursor:v1')).toBe('1');
});
it('reacquires leadership after permission loss and resumes the failed sequence', async () => {
  const s = setup();
  s.NotificationMock.permission = 'denied';
  s.source.emit('notice', { seq: 1, notice: notice() });
  s.runtime.refresh();
  await vi.waitFor(() => expect(s.source.closed).toBe(true));
  // Allow the Web Locks callback and its finally handler to release leadership.
  await new Promise(resolve => setTimeout(resolve, 0));
  s.NotificationMock.permission = 'granted'; s.runtime.refresh();
  expect(s.leadership).toHaveBeenCalledTimes(2);
  const recovered = Source.instances[1];
  expect(recovered.url).toBe('/api/dsh-notify/events?after=0');
  recovered.emit('notice', { seq: 1, notice: notice() });
  expect(s.show).toHaveBeenCalledTimes(1);
});
