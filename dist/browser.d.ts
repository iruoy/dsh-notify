import type { ServerResponse } from 'node:http';
import type { Store } from './store.js';
import type { HistoryEntry } from './types.js';
/** One stream per elected browser leader; replay window is the persisted last 200 events. */
export declare class BrowserStream {
    private store;
    private clients;
    constructor(store: Store);
    private write;
    private packet;
    private eligible;
    connect(res: ServerResponse, cursor?: number): void;
    publish(entry: HistoryEntry): void;
    dispose(): void;
}
