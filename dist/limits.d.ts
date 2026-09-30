/** Resource limits shared by host normalization and persisted-state validation. */
export declare const LIMITS: {
    readonly runs: 64;
    readonly route: 200;
    readonly sessionId: 200;
    readonly id: 1000;
    readonly title: 200;
    readonly workspace: 1000;
    readonly text: 1500;
    readonly batch: 100;
    readonly pendingPerSession: 200;
    readonly pendingTotal: 2000;
};
export declare function boundedString(value: unknown, max: number): value is string;
