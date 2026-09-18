import Schema from '@deepseek-ai/schemastery';
import { type Settings } from './types.js';
export interface PluginConfig {
    dataDir?: string;
    baseUrl?: string;
}
export declare const Config: Schema<PluginConfig>;
export declare function defaults(baseUrl?: string): Settings;
export declare class ValidationError extends Error {
}
export declare function record(value: unknown): Record<string, unknown>;
export declare function validateBaseUrl(value: unknown): string;
export declare function validateWebhook(value: unknown): string;
export declare function validateSettings(value: unknown): Settings;
