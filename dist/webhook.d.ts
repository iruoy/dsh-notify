import { type Notice } from './types.js';
import type { Store } from './store.js';
export declare function sessionUrl(baseUrl: string, sessionId: string): string;
export declare function slackPayload(notice: Notice, baseUrl: string): object;
export declare function retryDelay(header: string | null, attempt: number, now?: number): number;
export interface SendResult {
    ok: boolean;
    retry: boolean;
    error?: string;
    delay?: number;
}
export declare function sendSlack(url: string, payload: object, attempt: number, signal: AbortSignal, fetcher?: typeof fetch): Promise<SendResult>;
export declare class SlackQueue {
    private store;
    private fetcher;
    private busy;
    private stopped;
    private controller;
    private timer?;
    constructor(store: Store, fetcher?: typeof fetch);
    start(): void;
    dispose(): void;
    tick(now?: number): Promise<void>;
    test(): Promise<SendResult>;
}
