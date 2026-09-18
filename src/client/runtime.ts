import { API, LABELS, type Notice } from '../types.js';

export async function request<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(API + path, {
    method, credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-dsh-notify': '1' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(15_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result as T;
}
export function permissionStatus(): string {
  if (!window.isSecureContext) return 'HTTPS is required for browser notifications.';
  if (!('Notification' in window)) return 'This browser does not support desktop notifications.';
  return Notification.permission === 'granted' ? 'Enabled' : Notification.permission === 'denied' ? 'Blocked — allow notifications in your browser’s site settings.' : 'Not enabled';
}
const CURSOR = 'dsh-notify:cursor:v1';
export class BrowserRuntime {
  private abort = new AbortController();
  private release?: () => void;
  private source?: EventSource;
  private waiting = false;
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
    if (!('Notification' in window) || Notification.permission !== 'granted') { this.release?.(); this.setStatus(permissionStatus()); return; }
    if (!navigator.locks) { this.setStatus('This browser needs Web Locks support for notification delivery.'); return; }
    if (this.waiting) return;
    this.waiting = true;
    this.setStatus('Waiting for the notification tab');
    void navigator.locks.request('dsh-notify:leader', { signal: this.abort.signal }, async () => {
      if (this.stopped || Notification.permission !== 'granted') return;
      await new Promise<void>(resolve => {
        this.release = resolve;
        this.connect();
      });
      this.source?.close(); this.source = undefined; this.release = undefined;
    }).catch(() => { if (!this.stopped) this.setStatus('Could not acquire notification leadership.'); }).finally(() => { this.waiting = false; });
  };
  private cursor(): number | undefined {
    try { const raw = localStorage.getItem(CURSOR); if (raw === null) return; const value = Number(raw); return Number.isSafeInteger(value) && value >= 0 ? value : undefined; } catch { return; }
  }
  private saveCursor(seq: number): void { try { localStorage.setItem(CURSOR, String(seq)); } catch { /* Same-tab EventSource still carries Last-Event-ID. */ } }
  private connect(): void {
    const after = this.cursor();
    this.source = new EventSource(API + '/events' + (after === undefined ? '' : `?after=${after}`));
    this.source.onopen = () => { this.setStatus('Connected'); this.channel?.postMessage('leader'); };
    this.source.onerror = () => this.setStatus('Disconnected — reconnecting');
    this.source.addEventListener('cursor', event => this.saveCursor(Number((event as MessageEvent).data)));
    this.source.addEventListener('gap', () => this.setStatus('Replay window exceeded — check recent deliveries'));
    this.source.addEventListener('notice', event => {
      try {
        const { seq, notice } = JSON.parse((event as MessageEvent).data) as { seq: number; notice: Notice };
        if (seq <= (this.cursor() ?? -1)) return;
        let delivered = false;
        try { this.show(notice); delivered = true; } catch { this.setStatus('Notification could not be shown. Check browser permissions.'); }
        this.saveCursor(seq);
        void request('/ack', 'POST', { seq, delivered }).catch(() => this.setStatus('Notification receipt could not be saved'));
      } catch { this.setStatus('Invalid notification received'); }
    });
  }
  show(notice: Notice): void {
    if (Notification.permission !== 'granted') throw new Error('Enable browser notifications first.');
    const notification = new Notification(LABELS[notice.kind], { body: notice.title, tag: `dsh-notify:${notice.id}` });
    notification.onclick = () => { window.focus(); if (notice.sessionId) this.open(notice.sessionId); notification.close(); };
  }
  test(): void { this.show({ id: 'test', kind: 'completed', title: 'DSH Notify is ready.', sessionId: '', time: Date.now() }); }
  dispose(): void {
    this.stopped = true; this.abort.abort(); this.release?.(); this.source?.close(); this.channel?.close();
    window.removeEventListener('focus', this.refresh); this.listeners.clear();
  }
}
