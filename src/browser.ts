import type { ServerResponse } from 'node:http';
import type { Store } from './store.js';
import type { HistoryEntry } from './types.js';

/** One stream per elected browser leader; replay window is the persisted last 200 events. */
export class BrowserStream {
  private clients = new Set<ServerResponse>();
  constructor(private store: Store) {}
  private write(res: ServerResponse, text: string): void {
    if (res.destroyed) return;
    // A normal 200-event replay can exceed Node's high-water mark. Allow that
    // burst, but bound buffered data for a consumer that remains stalled.
    if (res.writableLength > 1_048_576) { this.clients.delete(res); res.destroy(); return; }
    res.write(text);
  }
  private packet(entry: HistoryEntry): string {
    const { summary: _summary, input: _input, ...notice } = entry.notice;
    return `id: ${entry.seq}\nevent: notice\ndata: ${JSON.stringify({ seq: entry.seq, notice })}\n\n`;
  }
  private eligible(entry: HistoryEntry): boolean {
    const browser = this.store.state.settings.browser;
    return entry.browser !== 'disabled' && browser.enabled && browser.events[entry.notice.kind];
  }
  connect(res: ServerResponse, cursor?: number): void {
    if (this.clients.size >= 50) { res.writeHead(503); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'connection': 'keep-alive', 'x-accel-buffering': 'no' });
    res.flushHeaders();
    this.clients.add(res);
    // Fresh browsers start now; reconnects replay only their missing records.
    if (cursor !== undefined) {
      const oldest = this.store.state.history[0]?.seq ?? this.store.state.sequence;
      if (cursor < oldest - 1 || cursor > this.store.state.sequence) this.write(res, 'event: gap\ndata: {"message":"Replay window exceeded; check recent deliveries."}\n\n');
      for (const entry of this.store.state.history) if (entry.seq > cursor && this.eligible(entry)) this.write(res, this.packet(entry));
    }
    this.write(res, `id: ${this.store.state.sequence}\nevent: cursor\ndata: ${this.store.state.sequence}\n\n`);
    const heartbeat = setInterval(() => this.write(res, ': heartbeat\n\n'), 15_000);
    heartbeat.unref();
    res.on('close', () => { clearInterval(heartbeat); this.clients.delete(res); });
  }
  publish(entry: HistoryEntry): void {
    if (!this.eligible(entry)) return;
    for (const res of this.clients) this.write(res, this.packet(entry));
  }
  dispose(): void { for (const res of this.clients) res.end(); this.clients.clear(); }
}
