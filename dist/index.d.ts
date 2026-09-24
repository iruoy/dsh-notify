import type { Context } from '@deepseek-ai/cordis';
import { Config, type PluginConfig } from './config.js';
/** Minimal compatible shape of DSH's question waterfall, without a runtime dependency. */
declare module '@deepseek-ai/cordis' {
    interface Events {
        'user-questions/request': (request: {
            agent?: {
                id: string;
            };
            questions?: {
                id?: string;
            }[];
        }, next: () => Promise<unknown>) => Promise<unknown>;
    }
}
export declare const name = "dsh-notify";
export declare const inject: string[];
export { Config };
export declare function apply(ctx: Context, config?: PluginConfig): void;
