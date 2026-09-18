import type { IncomingMessage, ServerResponse } from 'node:http';
import { type Store } from './store.js';
import type { BrowserStream } from './browser.js';
import type { SlackQueue } from './webhook.js';
export interface WebServer {
    register(route: {
        kind: 'exact';
        path: string;
        handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
    }): () => void;
}
export interface Connection {
    requestRejection(request: {
        headers: IncomingMessage['headers'];
    }): 401 | 403 | undefined;
}
export declare function registerApi(web: WebServer, connection: Connection, store: Store, stream: BrowserStream, queue: SlackQueue): () => void;
