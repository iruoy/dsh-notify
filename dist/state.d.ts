import { type Notice, type State } from './types.js';
export declare function parseNotice(value: unknown): Notice;
/** Parse all persisted records before migrations can inspect or rewrite them. */
export declare function parseState(value: unknown): State;
