import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { type Notice } from './types.js';
/** Incrementally fold committed events, without depending on DSH's removed session.events API. */
export declare class EventNormalizer {
    private turns;
    observe(sessionId: string, title: string | undefined, event: SessionEvent, includeSummary: boolean): Notice | undefined;
    forget(id: string): void;
}
/** DSH appends turn/end before setting idle. Hold terminal notifications until idle. */
export declare class CompletionGate {
    private pending;
    enqueue(notice: Notice): void;
    flush(id: string): Notice[];
}
