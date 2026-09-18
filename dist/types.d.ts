export declare const KINDS: readonly ['completed', 'error', 'aborted', 'blocked', 'max-tokens', 'interrupted', 'approval'];
export type Kind = typeof KINDS[number];
export declare const LABELS: Record<Kind, string>;
export type EventSwitches = Record<Kind, boolean>;
export interface Settings {
    notifySubagents: boolean;
    baseUrl: string;
    browser: {
        enabled: boolean;
        events: EventSwitches;
    };
    slack: {
        enabled: boolean;
        events: EventSwitches;
        includeSummary: boolean;
    };
}
export interface SettingsView extends Settings {
    revision: number;
    webhookConfigured: boolean;
}
export interface Notice {
    id: string;
    kind: Kind;
    sessionId: string;
    title: string;
    time: number;
    durationMs?: number;
    summary?: string;
}
export type Delivery = 'disabled' | 'waiting' | 'delivered' | 'retrying' | 'failed' | 'cancelled';
export interface HistoryEntry {
    seq: number;
    notice: Notice;
    browser: Delivery;
    slack: Delivery;
    attempts: number;
    nextAttempt?: number;
    error?: string;
}
export interface State {
    version: 1;
    revision: number;
    settings: Settings;
    webhook: string;
    sequence: number;
    history: HistoryEntry[];
    seen: string[];
    queue: {
        seq: number;
        notice: Notice;
        attempts: number;
        nextAttempt: number;
    }[];
}
export declare const API = "/api/dsh-notify";
