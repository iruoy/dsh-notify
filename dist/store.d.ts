import type { HistoryEntry, Notice, SettingsView, State } from './types.js';
export declare class ConflictError extends Error {
}
export declare class Store {
    readonly directory: string;
    state: State;
    private path;
    constructor(directory: string, baseUrl?: string);
    /** Commit a complete snapshot, fsync before rename; the secret is never a separate partial write. */
    private persist;
    change(fn: (state: State) => void): void;
    view(): SettingsView;
    update(value: unknown): SettingsView;
    add(notice: Notice): HistoryEntry | undefined;
    ack(seq: number, delivered: boolean): void;
    history(): HistoryEntry[];
}
