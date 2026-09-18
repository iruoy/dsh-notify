import type { Context } from '@deepseek-ai/cordis';
import { Config, type PluginConfig } from './config.js';
export declare const name = "dsh-notify";
export declare const inject: string[];
export { Config };
export declare function apply(ctx: Context, config?: PluginConfig): void;
