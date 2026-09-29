import { type State } from './types.js';
/** Parse all persisted records before migrations can inspect or rewrite them. */
export declare function parseState(value: unknown): State;
