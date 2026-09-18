import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-title';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-client-connection';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Config, type PluginConfig } from './config.js';
import { EventNormalizer, CompletionGate } from './events.js';
import { Store } from './store.js';
import { SlackQueue } from './webhook.js';
import { BrowserStream } from './browser.js';
import { registerApi } from './api.js';
import type { Notice } from './types.js';

export const name = 'dsh-notify';
export const inject = ['sessions', 'agents'];
export { Config };
export function apply(ctx: Context, config: PluginConfig = {}): void {
  const directory = config.dataDir || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-notify');
  const store = new Store(directory, config.baseUrl);
  const queue = new SlackQueue(store), stream = new BrowserStream(store), gate = new CompletionGate(), normalizer = new EventNormalizer();
  const rootSessions = new Set<string>();
  const emit = (notice: Notice): void => {
    try { const entry = store.add(notice); if (entry) stream.publish(entry); }
    catch { console.warn('[dsh-notify] Notification could not be persisted. Check the state directory.'); }
  };
  ctx.on('session/event', (session, event) => {
    const agent = ctx.agents.get(session.id);
    if (!agent || (!store.state.settings.notifySubagents && !ctx.agents.roots().includes(agent))) return;
    if (ctx.agents.roots().includes(agent)) rootSessions.add(String(agent.id));
    const title = ctx.get('sessionTitle')?.get(session)?.title;
    const notice = normalizer.observe(String(session.id), title, event, store.state.settings.slack.includeSummary, { workspace: session.header?.cwd, config: session.requestHeader?.()?.config });
    if (!notice) return;
    if (notice.kind === 'approval' || agent.status === 'idle') emit(notice);
    else gate.enqueue(notice);
  });
  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return;
    const pending = gate.flush(String(agent.id));
    if (store.state.settings.notifySubagents || ctx.agents.roots().includes(agent)) for (const notice of pending) emit(notice);
  });
  ctx.on('agent/disposed', ({ agent }) => {
    normalizer.forget(String(agent.id));
    // A terminal event may be followed by disposal without another idle transition.
    const pending = gate.flush(String(agent.id));
    if (store.state.settings.notifySubagents || rootSessions.has(String(agent.id))) for (const notice of pending) emit(notice);
    rootSessions.delete(String(agent.id));
  });
  ctx.effect(() => { queue.start(); return () => { queue.dispose(); stream.dispose(); }; }, 'dsh-notify: deliveries');
  ctx.inject(['webServer', 'connection'], web => {
    if (typeof web.connection.requestRejection !== 'function') {
      console.warn('[dsh-notify] Browser delivery requires DSH Connection.requestRejection (tested with 0.1.5-rc.2).'); return;
    }
    web.effect(() => registerApi(web.webServer, web.connection, store, stream, queue), 'dsh-notify: authenticated API');
  });
}
