import type { EpochHeader, SessionEvent } from '@deepseek-ai/dsh-session';
import { type Notice } from './types.js';
import type { PriceCall } from './pricing.js';
export interface NoticeContext {
    workspace?: string;
    config?: EpochHeader['config'];
}
/** Incrementally fold committed events, without depending on DSH's removed session.events API. */
export declare class EventNormalizer {
    private priceCall?;
    private turns;
    constructor(priceCall?: PriceCall | undefined);
    observe(sessionId: string, title: string | undefined, event: SessionEvent, includeSummary: boolean, context?: NoticeContext): Notice | undefined;
    forget(id: string): void;
}
/** DSH appends turn/end before setting idle. Hold terminal notifications until idle. */
export declare class CompletionGate {
    private pending;
    enqueue(notice: Notice): void;
    flush(id: string): Notice[];
}
