import Schema from '@deepseek-ai/schemastery';
import { KINDS, type EventSwitches, type Settings } from './types.js';

export interface PluginConfig { dataDir?: string; baseUrl?: string }
export const Config: Schema<PluginConfig> = Schema.object({
  dataDir: Schema.string().description('Private state directory. Default: $DSH_HOME/dsh-notify (or ~/.dsh/dsh-notify). Use a separate directory per DSH instance.'),
  baseUrl: Schema.string().description('Public HTTPS DSH origin for Slack links. Can also be saved in DSH Notify settings.'),
});
const all = (): EventSwitches => Object.fromEntries(KINDS.map(k => [k, true])) as EventSwitches;
export function defaults(baseUrl = ''): Settings {
  return { notifySubagents: false, baseUrl: validateBaseUrl(baseUrl), browser: { enabled: true, events: all() }, slack: { enabled: true, events: all(), includeSummary: false } };
}
export class ValidationError extends Error {}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Expected an object.');
  return value as Record<string, unknown>;
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new ValidationError('Expected a boolean.');
  return value;
}
export function validateBaseUrl(value: unknown): string {
  if (value === '') return '';
  if (typeof value !== 'string' || value.length > 2048) throw new ValidationError('Invalid DSH base URL.');
  let url: URL;
  try { url = new URL(value); } catch { throw new ValidationError('Invalid DSH base URL.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new ValidationError('Use an HTTPS DSH origin (HTTP is allowed on localhost), without a path, credentials or query.');
  }
  return url.origin;
}
export function validateWebhook(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1024) throw new ValidationError('Invalid Slack webhook.');
  let url: URL;
  try { url = new URL(value); } catch { throw new ValidationError('Invalid Slack webhook.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'hooks.slack.com' || url.port || url.username || url.password || url.search || url.hash || !/^\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(url.pathname)) {
    throw new ValidationError('Use an https://hooks.slack.com/services/… incoming webhook.');
  }
  return url.href;
}
export function validateSettings(value: unknown): Settings {
  const s = record(value), browser = record(s.browser), slack = record(s.slack);
  const events = (v: unknown): EventSwitches => {
    const input = record(v);
    return Object.fromEntries(KINDS.map(k => [k, bool(input[k])])) as EventSwitches;
  };
  return { notifySubagents: bool(s.notifySubagents), baseUrl: validateBaseUrl(s.baseUrl),
    browser: { enabled: bool(browser.enabled), events: events(browser.events) },
    slack: { enabled: bool(slack.enabled), events: events(slack.events), includeSummary: bool(slack.includeSummary) } };
}
