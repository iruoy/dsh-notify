import { type Notice, type State } from './types.js';
/** Shared with event normalization so accepted usage always satisfies these persisted-state rules. */
export declare const isCount: (value: unknown) => value is number;
export declare const isTimestamp: (value: unknown) => value is number;
export declare function parseNotice(value: unknown): Notice;
/** Parse all persisted records before migrations can inspect or rewrite them. */
export declare function parseState(value: unknown): State;
