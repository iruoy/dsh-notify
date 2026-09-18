import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import type { Notice } from '../src/types.js';
export const WEBHOOK = 'https://hooks.slack.com/services/T000/B000/fake-test-secret';
export const notice = (id = 's:turn:1'): Notice => ({ id, kind: 'completed', sessionId: 's', title: 'A task', time: 12345, durationMs: 123000 });
export function fixture(slack = true) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-notify-test-'));
  const store = new Store(dir);
  if (slack) store.update({ revision: 0, settings: store.view(), webhook: WEBHOOK });
  return { dir, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
