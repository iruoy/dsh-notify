import { API, LABELS, type Notice } from '../types.js';

export class RequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export async function request<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(API + path, {
    method, credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-dsh-notify': '1' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(15_000),
  });
  const result = await response.json();
  if (!response.ok) throw new RequestError(result.error || `Request failed (${response.status}).`, response.status);
  return result as T;
}
export function permissionStatus(): string {
  if (!window.isSecureContext) return 'HTTPS is required for browser notifications.';
  if (!('Notification' in window)) return 'This browser does not support desktop notifications.';
  return Notification.permission === 'granted' ? 'Enabled' : Notification.permission === 'denied' ? 'Blocked — allow notifications in your browser’s site settings.' : 'Not enabled';
}
/** Whether asking for permission can still change anything: supported, secure, and not yet granted or denied. */
export function permissionUndecided(): boolean {
  return window.isSecureContext && 'Notification' in window && Notification.permission === 'default';
}
/** Whether this browser may show notifications at all. */
export function permissionGranted(): boolean {
  return window.isSecureContext && 'Notification' in window && Notification.permission === 'granted';
}
const CURSOR = 'dsh-notify:cursor:v1';
export class BrowserRuntime {
  private abort = new AbortController();
  private release?: () => void;
  private source?: EventSource;
  private connectionRetry?: ReturnType<typeof setTimeout>;
  private connectionRetryDelay = 1000;
  private waiting = false;
  private paused = false;
  private lastCursor?: number;
  private cursorSaved = true;
  private receipts = new Set<number>();
  private acknowledging = new Set<number>();
  private receiptRetry?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private listeners = new Set<() => void>();
  private channel?: BroadcastChannel;
  private status = 'Not connected';
  constructor(private open: (sessionId: string) => void) {}
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  snapshot = (): string => this.status;
  private setStatus(value: string): void { this.status = value; for (const listener of this.listeners) listener(); }
  start(): void {
    if ('BroadcastChannel' in window) {
      this.channel = new BroadcastChannel('dsh-notify');
      this.channel.onmessage = () => { if (!this.source) this.setStatus('Another tab is receiving notifications'); };
    }
    window.addEventListener('focus', this.refresh);
    this.refresh();
  }
  refresh = (): void => {
    if (this.stopped) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') { this.disconnect(); this.release?.(); this.setStatus(permissionStatus()); return; }
    if (!navigator.locks) { this.setStatus('This browser needs Web Locks support for notification delivery.'); return; }
    for (const seq of this.receipts) this.acknowledge(seq);
    if (this.waiting) {
      if (this.paused && this.release) { this.paused = false; this.connect(); }
      return;
    }
    this.waiting = true;
    this.setStatus('Waiting for the notification tab');
    void navigator.locks.request('dsh-notify:leader', { signal: this.abort.signal }, async () => {
      if (this.stopped || Notification.permission !== 'granted') return;
      // The previous leader may have observed a server reset, so adopt its shared
      // cursor. If our own last write failed, storage may lag our progress instead.
      const shared = this.sharedCursor();
      if (shared !== undefined) this.lastCursor = this.cursorSaved ? shared : Math.max(shared, this.lastCursor ?? 0);
      await new Promise<void>(resolve => {
        this.release = resolve;
        this.paused = false;
        this.connectionRetryDelay = 1000;
        this.connect();
      });
      this.disconnect(); this.release = undefined;
    }).catch(() => { if (!this.stopped) this.setStatus('Could not acquire notification leadership.'); }).finally(() => { this.waiting = false; });
  };
  private sharedCursor(): number | undefined {
    try {
      const raw = localStorage.getItem(CURSOR), value = raw === null ? undefined : Number(raw);
      if (value !== undefined && Number.isSafeInteger(value) && value >= 0) return value;
    } catch { /* Keep same-tab replay safe when storage is unavailable. */ }
    return undefined;
  }
  private saveCursor(seq: number): void {
    if (!Number.isSafeInteger(seq) || seq < 0) return;
    // Server cursors are authoritative, including after persisted state is reset.
    this.lastCursor = seq;
    try { localStorage.setItem(CURSOR, String(seq)); this.cursorSaved = true; } catch { this.cursorSaved = false; /* In-memory cursor survives same-tab recovery. */ }
  }
  private acknowledge(seq: number): void {
    if (this.stopped || this.acknowledging.has(seq)) return;
    this.acknowledging.add(seq);
    void request('/ack', 'POST', { seq, delivered: true }).then(() => {
      this.receipts.delete(seq);
    }).catch((error: unknown) => {
      if (error instanceof RequestError && error.status === 400) {
        // The server no longer retains this sequence; retrying cannot restore it.
        this.receipts.delete(seq);
        return;
      }
      if (this.stopped) return;
      if (!this.paused) this.setStatus('Notification receipt could not be saved — retrying');
      if (!this.receiptRetry) this.receiptRetry = setTimeout(() => {
        this.receiptRetry = undefined;
        for (const pending of this.receipts) this.acknowledge(pending);
      }, 5000);
    }).finally(() => this.acknowledging.delete(seq));
  }
  private pause(message: string): void {
    this.paused = true;
    this.disconnect();
    // Retain leadership so another tab cannot advance past the failed notice.
    this.setStatus(message);
  }
  private disconnect(): void {
    clearTimeout(this.connectionRetry); this.connectionRetry = undefined;
    this.source?.close(); this.source = undefined;
  }
  private connect(): void {
    if (this.stopped || this.paused || !this.release) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') { this.refresh(); return; }
    // Only the lock holder writes the cursor, so the value synced at acquisition stays authoritative.
    const after = this.lastCursor;
    const source = this.source = new EventSource(API + '/events' + (after === undefined ? '' : `?after=${after}`));
    const active = () => !this.stopped && !this.paused && this.source === source;
    source.onopen = () => { if (active()) { this.connectionRetryDelay = 1000; this.setStatus('Connected'); this.channel?.postMessage('leader'); } };
    source.onerror = () => {
      if (!active()) return;
      this.setStatus('Disconnected — reconnecting');
      // CONNECTING streams retry natively; CLOSED streams need a replacement.
      if (source.readyState !== EventSource.CLOSED) return;
      this.disconnect();
      // Keep the Web Lock and cursor while retrying, with backoff capped at 30 seconds.
      this.connectionRetry = setTimeout(() => {
        this.connectionRetry = undefined;
        this.connect();
      }, this.connectionRetryDelay);
      this.connectionRetryDelay = Math.min(this.connectionRetryDelay * 2, 30_000);
    };
    source.addEventListener('cursor', event => { if (active()) this.saveCursor(Number((event as MessageEvent).data)); });
    source.addEventListener('gap', () => { if (active()) this.setStatus('Replay window exceeded — check recent deliveries'); });
    source.addEventListener('notice', event => {
      if (!active()) return;
      try {
        const { seq, notice } = JSON.parse((event as MessageEvent).data) as { seq: number; notice: Notice };
        if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('Invalid sequence');
        if (seq <= (this.lastCursor ?? -1)) return;
        try { this.show(notice); } catch {
          this.pause('Notification could not be shown. Check browser permissions, then focus this tab to retry.');
          void request('/ack', 'POST', { seq, delivered: false }).catch(() => {});
          return;
        }
        this.saveCursor(seq);
        this.receipts.add(seq);
        // Only 200 records can still be acknowledged in the server history.
        if (this.receipts.size > 200) this.receipts.delete(this.receipts.values().next().value!);
        this.acknowledge(seq);
      } catch { this.pause('Invalid notification received — focus this tab to retry.'); }
    });
  }
  show(notice: Notice): void {
    if (Notification.permission !== 'granted') throw new Error('Enable browser notifications first.');
    const notification = new Notification(LABELS[notice.kind], { body: notice.title, tag: `dsh-notify:${notice.id}` });
    notification.onclick = () => { window.focus(); if (notice.sessionId) this.open(notice.sessionId); notification.close(); };
  }
  test(): void { this.show({ id: 'test', kind: 'completed', title: 'DSH Notify is ready.', sessionId: '', time: Date.now() }); }
  dispose(): void {
    this.stopped = true; clearTimeout(this.receiptRetry); this.abort.abort(); this.release?.(); this.disconnect(); this.channel?.close();
    window.removeEventListener('focus', this.refresh); this.listeners.clear();
  }
}
