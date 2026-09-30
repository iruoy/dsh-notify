import { afterEach, expect, it, vi } from 'vitest';
import { BrowserRuntime } from '../src/client/runtime.js';
import { notice } from './fixtures.js';

class Source {
  static instances: Source[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  readyState = Source.CONNECTING;
  handlers = new Map<string, (event: { data: string }) => void>();
  closed = false;
  onopen?: () => void;
  onerror?: () => void;
  constructor(readonly url: string) { Source.instances.push(this); }
  addEventListener(type: string, fn: (event: { data: string }) => void) { this.handlers.set(type, fn); }
  emit(type: string, data: unknown) { this.handlers.get(type)?.({ data: JSON.stringify(data) }); }
  open() { this.readyState = Source.OPEN; this.onopen?.(); }
  fail(terminal = true) { this.readyState = terminal ? Source.CLOSED : Source.CONNECTING; this.onerror?.(); }
  close() { this.closed = true; this.readyState = Source.CLOSED; }
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
it('recreates a terminally closed stream under the same leadership and replays from the saved cursor', async () => {
  vi.useFakeTimers();
  const s = setup();
  s.source.emit('cursor', 4);
  s.source.fail();
  s.source.fail();
  s.runtime.refresh();
  expect(s.runtime.snapshot()).toBe('Disconnected — reconnecting');
  expect(Source.instances).toHaveLength(1);
  s.source.emit('cursor', 99);
  await vi.advanceTimersByTimeAsync(1000);
  expect(Source.instances).toHaveLength(2);
  expect(s.source.closed).toBe(true);
  expect(s.leadership).toHaveBeenCalledTimes(1);
  const recovered = Source.instances[1];
  expect(recovered.url).toBe('/api/dsh-notify/events?after=4');
  recovered.open();
  expect(s.runtime.snapshot()).toBe('Connected');
  recovered.emit('notice', { seq: 5, notice: notice('replayed') });
  s.source.emit('notice', { seq: 6, notice: notice('stale') });
  s.source.fail();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(s.show).toHaveBeenCalledTimes(1);
  expect(s.values.get('dsh-notify:cursor:v1')).toBe('5');
  expect(Source.instances).toHaveLength(2);
});
it('leaves nonterminal reconnects to EventSource', async () => {
  vi.useFakeTimers();
  const s = setup();
  s.source.fail(false);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(Source.instances).toHaveLength(1);
  expect(s.source.closed).toBe(false);
  s.source.open();
  expect(s.runtime.snapshot()).toBe('Connected');
});
it('backs off repeated terminal failures to a capped delay and resets after opening', async () => {
  vi.useFakeTimers();
  const s = setup();
  for (const delay of [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]) {
    const count = Source.instances.length;
    Source.instances.at(-1)!.fail();
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(Source.instances).toHaveLength(count);
    await vi.advanceTimersByTimeAsync(1);
    expect(Source.instances).toHaveLength(count + 1);
  }
  expect(s.leadership).toHaveBeenCalledTimes(1);
  const recovered = Source.instances.at(-1)!;
  recovered.open();
  recovered.fail();
  const count = Source.instances.length;
  await vi.advanceTimersByTimeAsync(1000);
  expect(Source.instances).toHaveLength(count + 1);
});
it.each(['dispose', 'permission', 'permission without focus'])('stops terminal connection retries on %s', async reason => {
  vi.useFakeTimers();
  const s = setup();
  s.source.fail();
  if (reason === 'dispose') s.runtime.dispose();
  else {
    s.NotificationMock.permission = 'denied';
    if (reason === 'permission') s.runtime.refresh();
  }
  await vi.advanceTimersByTimeAsync(60_000);
  expect(Source.instances).toHaveLength(1);
  expect(s.source.closed).toBe(true);
  if (reason !== 'dispose') {
    expect(s.runtime.snapshot()).toContain('Blocked');
    s.NotificationMock.permission = 'granted';
    s.runtime.refresh();
    expect(s.leadership).toHaveBeenCalledTimes(2);
    expect(Source.instances).toHaveLength(2);
  }
});
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
it.each([false, true])('resumes the shared cursor after leadership changes (storage unavailable: %s)', async storageFails => {
  const s = setup(storageFails);
  s.source.emit('cursor', 100);
  s.NotificationMock.permission = 'denied';
  s.runtime.refresh();
  await new Promise(resolve => setTimeout(resolve, 0));
  // Another leader observes restored server state while this tab has released its lock.
  s.values.set('dsh-notify:cursor:v1', '50');
  s.NotificationMock.permission = 'granted';
  s.runtime.refresh();
  const recovered = Source.instances[1];
  expect(recovered.url).toBe(`/api/dsh-notify/events?after=${storageFails ? 100 : 50}`);
  if (!storageFails) {
    // The server replays notices before sending its final cursor packet.
    for (let seq = 51; seq <= 55; seq++) recovered.emit('notice', { seq, notice: notice(String(seq)) });
    recovered.emit('cursor', 55);
    expect(s.show).toHaveBeenCalledTimes(5);
    expect(s.values.get('dsh-notify:cursor:v1')).toBe('55');
  }
});
it('keeps its own progress when only storage writes fail', async () => {
  const s = setup();
  s.source.emit('cursor', 100);
  localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  // A server reset must not be masked by the stale stored cursor.
  s.source.emit('cursor', 40);
  s.source.emit('notice', { seq: 41, notice: notice('after-reset') });
  expect(s.show).toHaveBeenCalledTimes(1);
  expect(s.values.get('dsh-notify:cursor:v1')).toBe('100');
  // Reacquiring leadership keeps unsaved progress over our own stale, higher stored value.
  s.NotificationMock.permission = 'denied';
  s.runtime.refresh();
  await new Promise(resolve => setTimeout(resolve, 0));
  s.NotificationMock.permission = 'granted';
  s.runtime.refresh();
  expect(Source.instances[1].url).toBe('/api/dsh-notify/events?after=41');
});
it('adopts a cursor another leader wrote after its own storage write failed', async () => {
  const s = setup();
  s.source.emit('cursor', 90);
  localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  s.source.emit('cursor', 100);
  s.NotificationMock.permission = 'denied';
  s.runtime.refresh();
  await new Promise(resolve => setTimeout(resolve, 0));
  // Another leader observed a server reset and saved its lower cursor.
  s.values.set('dsh-notify:cursor:v1', '20');
  s.NotificationMock.permission = 'granted';
  s.runtime.refresh();
  expect(Source.instances[1].url).toBe('/api/dsh-notify/events?after=20');
});
it.each([
  { storageFails: false, resetCursor: 0 },
  { storageFails: false, resetCursor: 40 },
  { storageFails: true, resetCursor: 0 },
  { storageFails: true, resetCursor: 40 },
])('recovers after the server cursor resets to $resetCursor (storage unavailable: $storageFails)', ({ storageFails, resetCursor }) => {
  const s = setup(storageFails);
  s.source.emit('cursor', 100);
  // EventSource reconnects after the server recreates or restores its state.
  s.source.emit('gap', { message: 'Replay window exceeded; check recent deliveries.' });
  s.source.emit('cursor', resetCursor);
  if (!storageFails) expect(s.values.get('dsh-notify:cursor:v1')).toBe(String(resetCursor));
  const seq = resetCursor + 1;
  s.source.emit('notice', { seq, notice: notice('after-reset') });
  s.source.emit('notice', { seq, notice: notice('duplicate') });
  expect(s.show).toHaveBeenCalledTimes(1);
  if (!storageFails) expect(s.values.get('dsh-notify:cursor:v1')).toBe(String(seq));
  s.show.mockImplementationOnce(() => { throw new Error('Display failed'); });
  s.source.emit('notice', { seq: seq + 1, notice: notice('failed') });
  s.runtime.refresh();
  expect(Source.instances[1].url).toBe(`/api/dsh-notify/events?after=${seq}`);
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
it('waits for lock ownership before reconnecting a paused tab after permission is restored', async () => {
  const s = setup();
  s.NotificationMock.permission = 'denied';
  s.source.emit('notice', { seq: 1, notice: notice() });
  s.runtime.refresh();
  // Allow the Web Locks callback and its finally handler to release leadership.
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(s.source.closed).toBe(true);
  // Another tab holds the lock, so this tab's next request remains queued.
  let acquire!: () => void;
  s.leadership.mockImplementationOnce((_name, _options, fn) => new Promise(resolve => {
    acquire = () => resolve(fn());
  }));
  s.NotificationMock.permission = 'granted';
  s.runtime.refresh();
  s.runtime.refresh();
  s.runtime.refresh();
  expect(s.leadership).toHaveBeenCalledTimes(2);
  expect(Source.instances).toHaveLength(1);
  expect(s.runtime.snapshot()).toBe('Waiting for the notification tab');
  acquire();
  expect(Source.instances).toHaveLength(2);
  const recovered = Source.instances[1];
  expect(recovered.url).toBe('/api/dsh-notify/events?after=0');
  s.source.emit('notice', { seq: 1, notice: notice('stale') });
  recovered.emit('notice', { seq: 1, notice: notice() });
  expect(s.show).toHaveBeenCalledTimes(1);
  expect(Source.instances.filter(source => !source.closed)).toEqual([recovered]);
});
