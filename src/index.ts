import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-title';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-client-connection';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Config, type PluginConfig } from './config.js';
import { EventNormalizer, CompletionGate } from './events.js';
import { Store } from './store.js';
import { SlackQueue } from './webhook.js';
import { BrowserStream } from './browser.js';
import { registerApi } from './api.js';
import { PricingCache } from './pricing.js';
import type { Notice } from './types.js';

/** Minimal compatible shape of DSH's question waterfall, without a runtime dependency. */
declare module '@deepseek-ai/cordis' {
  interface Events {
    'user-questions/request': (request: { agent?: { id: string }; questions?: { id?: string }[] }, next: () => Promise<unknown>) => Promise<unknown>;
  }
}

export const name = 'dsh-notify';
export const inject = ['sessions', 'agents'];
export { Config };
export function apply(ctx: Context, config: PluginConfig = {}): void {
  const directory = config.dataDir || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-notify');
  const store = new Store(directory, config.baseUrl);
  const pricing = new PricingCache(directory);
  const queue = new SlackQueue(store), stream = new BrowserStream(store), gate = new CompletionGate(), normalizer = new EventNormalizer(pricing.estimate);
  const rootSessions = new Set<string>();
  const emit = (notice: Notice): void => {
    try { const entry = store.add(notice); if (entry) stream.publish(entry); }
    catch { console.warn('[dsh-notify] Notification could not be persisted. Check the state directory.'); }
  };
  ctx.on('session/event', (session, event) => {
    const agent = ctx.agents.get(session.id);
    if (!agent) return;
    if (ctx.agents.roots().includes(agent)) rootSessions.add(String(agent.id));
    const title = ctx.get('sessionTitle')?.get(session)?.title;
    const notice = normalizer.observe(String(session.id), title, event, store.state.settings.slack.includeSummary, { workspace: session.header?.cwd, config: session.requestHeader?.()?.config });
    if (!notice) return;
    notice.isSubagent = !rootSessions.has(String(agent.id));
    if (notice.kind === 'approval' || agent.status === 'idle') emit(notice);
    else gate.enqueue(notice);
  });
  ctx.on('user-questions/request', async (request, next) => {
    const sessionId = String(request.agent?.id ?? 'agentless');
    emit({ id: `${sessionId}:question:${request.questions?.[0]?.id ?? randomUUID()}`, kind: 'question', sessionId,
      title: `Session ${sessionId}`, time: Date.now(), isSubagent: !!request.agent && !ctx.agents.roots().some(agent => String(agent.id) === sessionId) });
    return next();
  });
  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return;
    const pending = gate.flush(String(agent.id));
    for (const notice of pending) emit(notice);
  });
  ctx.on('agent/disposed', ({ agent }) => {
    normalizer.forget(String(agent.id));
    // A terminal event may be followed by disposal without another idle transition.
    const pending = gate.flush(String(agent.id));
    for (const notice of pending) emit(notice);
    rootSessions.delete(String(agent.id));
  });
  ctx.effect(() => { queue.start(); pricing.start(); return () => { queue.dispose(); stream.dispose(); pricing.dispose(); }; }, 'dsh-notify: deliveries');
  ctx.inject(['webServer', 'connection'], web => {
    if (typeof web.connection.requestRejection !== 'function') {
      console.warn('[dsh-notify] Browser delivery requires DSH Connection.requestRejection (tested with 0.1.5-rc.2).'); return;
    }
    web.effect(() => registerApi(web.webServer, web.connection, store, stream, queue), 'dsh-notify: authenticated API');
  });
}
