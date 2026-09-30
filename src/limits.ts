/** Resource limits shared by host normalization and persisted-state validation. */
export const LIMITS = {
  runs: 64, route: 200, sessionId: 200, id: 1000, title: 200,
  workspace: 1000, text: 1500, batch: 100, pendingPerSession: 200, pendingTotal: 2000,
} as const;
export function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}
