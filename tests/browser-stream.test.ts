import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { expect, it, vi } from 'vitest';
import { BrowserStream } from '../src/browser.js';
import { fixture, notice } from './fixtures.js';

function client() {
  const res = Object.assign(new EventEmitter(), {
    destroyed: false, writableLength: 0,
    writeHead: vi.fn(), flushHeaders: vi.fn(), write: vi.fn(),
    end() { this.emit('close'); }, destroy() { this.destroyed = true; this.emit('close'); },
  });
  return res;
}
it('serializes one privacy-filtered packet for all clients and preserves backpressure handling', async () => {
  const f = await fixture(false), stream = new BrowserStream(f.store);
  const clients = Array.from({ length: 50 }, client);
  try {
    const entry = (await f.store.add({ ...notice(), input: 'PRIVATE INPUT', summary: 'PRIVATE SUMMARY' }))!;
    const stringify = vi.spyOn(JSON, 'stringify');
    stream.publish(entry);
    expect(stringify).not.toHaveBeenCalled(); // No consumers need no packet.
    for (const res of clients) {
      stream.connect(res as unknown as ServerResponse);
      res.write.mockClear();
    }
    clients[0].writableLength = 1_048_577;
    stream.publish(entry);
    expect(stringify).toHaveBeenCalledTimes(1);
    expect(clients[0].destroyed).toBe(true);
    expect(clients[0].write).not.toHaveBeenCalled();
    const packet = clients[1].write.mock.calls[0][0];
    expect(packet).toContain(`id: ${entry.seq}\nevent: notice\n`);
    expect(packet).not.toContain('PRIVATE');
    for (const res of clients.slice(1)) expect(res.write).toHaveBeenCalledExactlyOnceWith(packet);
    const data = JSON.parse(packet.split('data: ')[1]);
    expect(data).toEqual({ seq: entry.seq, notice: f.store.history()[0].notice });
    stream.publish({ ...entry, browser: 'disabled' });
    expect(stringify).toHaveBeenCalledTimes(1);
  } finally { vi.restoreAllMocks(); stream.dispose(); f.cleanup(); }
});
