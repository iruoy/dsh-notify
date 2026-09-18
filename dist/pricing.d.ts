export declare const PRICING_URL = "https://models.dev/api.json";
export declare const PRICING_TTL: number;
export declare function publicPricingProvider(provider: string): string;
export interface CallUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
}
export interface CallCost {
    usd: number;
    fetchedAt: number;
    stale: boolean;
}
export type PriceCall = (provider: string, model: string, usage: CallUsage) => CallCost | undefined;
/** Public list prices only. Network and cache failures never block notifications. */
export declare class PricingCache {
    private directory;
    private fetcher;
    private now;
    private snapshot?;
    private pending?;
    private nextAttempt;
    private stopped;
    private timer?;
    private controller;
    private path;
    constructor(directory: string, fetcher?: typeof fetch, now?: () => number);
    start(): void;
    dispose(): void;
    refresh(): Promise<void>;
    private download;
    estimate: PriceCall;
}
