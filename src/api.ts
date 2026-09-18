import type { IncomingMessage, ServerResponse } from 'node:http';
import { API } from './types.js';
import { ConflictError, type Store } from './store.js';
import { record, ValidationError } from './config.js';
import type { BrowserStream } from './browser.js';
import type { SlackQueue } from './webhook.js';

export interface WebServer {
  register(route: { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void;
}
export interface Connection { requestRejection(request: { headers: IncomingMessage['headers'] }): 401 | 403 | undefined }
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}
async function body(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new ValidationError('application/json required.');
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16_384) throw new ValidationError('Request is too large.');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new ValidationError('Invalid JSON.'); }
}
export function registerApi(web: WebServer, connection: Connection, store: Store, stream: BrowserStream, queue: SlackQueue): () => void {
  const disposers: (() => void)[] = [];
  let testing = false, lastTest = 0;
  const route = (path: string, methods: string[], handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): void => {
    disposers.push(web.register({ kind: 'exact', path: API + path, handler: async (req, res) => {
      try {
        const rejection = connection.requestRejection(req);
        if (rejection) { json(res, rejection, { error: 'DSH authentication or origin check failed.' }); return; }
        if (!methods.includes(req.method ?? '')) { res.setHeader('allow', methods.join(', ')); json(res, 405, { error: 'Method not allowed.' }); return; }
        // A custom header on mutations forces a CORS preflight, which this API never allows.
        if (req.method !== 'GET' && req.headers['x-dsh-notify'] !== '1') { json(res, 403, { error: 'Missing request header.' }); return; }
        await handler(req, res);
      } catch (error) {
        if (res.headersSent) { res.destroy(); return; }
        json(res, error instanceof ConflictError ? 409 : error instanceof ValidationError ? 400 : 500,
          { error: error instanceof ValidationError || error instanceof ConflictError ? error.message : 'DSH Notify request failed.' });
      }
    } }));
  };
  route('/settings', ['GET', 'PUT'], async (req, res) => json(res, 200, req.method === 'GET' ? store.view() : store.update(await body(req))));
  route('/history', ['GET'], (_req, res) => json(res, 200, store.history()));
  route('/events', ['GET'], (req, res) => {
    const raw = req.headers['last-event-id'] ?? new URL(req.url!, 'http://localhost').searchParams.get('after');
    const cursor = raw === null || raw === undefined ? undefined : Number(raw);
    if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0)) throw new ValidationError('Invalid event cursor.');
    stream.connect(res, cursor);
  });
  route('/ack', ['POST'], async (req, res) => {
    const input = record(await body(req));
    if (typeof input.delivered !== 'boolean' || typeof input.seq !== 'number') throw new ValidationError('Invalid delivery receipt.');
    store.ack(input.seq, input.delivered); json(res, 200, { ok: true });
  });
  route('/test-slack', ['POST'], async (_req, res) => {
    if (testing || Date.now() - lastTest < 5000) { json(res, 429, { error: 'Please wait before sending another test.' }); return; }
    testing = true; lastTest = Date.now();
    try { const result = await queue.test(); json(res, result.ok ? 200 : 502, { ok: result.ok, error: result.error }); }
    finally { testing = false; }
  });
  return () => { for (const dispose of disposers) dispose(); stream.dispose(); };
}
