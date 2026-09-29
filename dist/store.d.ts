import type { HistoryEntry, Notice, SettingsView, State } from './types.js';
export declare class ConflictError extends Error {
}
export declare class Store {
    readonly directory: string;
    state: State;
    private tail;
    private failed;
    private closed;
    private constructor();
    static open(directory: string, baseUrl?: string): Promise<Store>;
    private slackAgentAllowed;
    private persist;
    private enqueue;
    assertHealthy(): void;
    idle(): Promise<void>;
    close(): Promise<void>;
    private commit;
    change(fn: (state: State) => void): Promise<void>;
    view(): SettingsView;
    update(value: unknown): Promise<SettingsView>;
    add(value: Notice): Promise<HistoryEntry | undefined>;
    /** Commit accepted notices in order with one durable snapshot write, skipping any that fail validation. */
    addMany(values: readonly Notice[]): Promise<{
        entries: HistoryEntry[];
        invalid: number;
    }>;
    ack(seq: number, delivered: boolean): Promise<void>;
    history(): HistoryEntry[];
}
