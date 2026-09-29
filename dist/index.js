import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Config } from './config.js';
import { EventNormalizer, CompletionGate } from './events.js';
import { Store } from './store.js';
import { SlackQueue } from './webhook.js';
import { BrowserStream } from './browser.js';
import { registerApi } from './api.js';
import { PricingCache } from './pricing.js';
export const name = 'dsh-notify';
export const inject = ['sessions', 'agents'];
export { Config };
export async function apply(ctx, config = {}) {
    const directory = config.dataDir || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-notify');
    const store = await Store.open(directory, config.baseUrl);
    const pricing = await PricingCache.open(directory);
    const queue = new SlackQueue(store), stream = new BrowserStream(store), gate = new CompletionGate(), normalizer = new EventNormalizer(pricing.estimate);
    const rootSessions = new Set();
    let stopped = false;
    const emit = async (...notices) => {
        if (!notices.length)
            return;
        // Publish only after the whole burst is durable, in sequence order.
        try {
            const entries = await store.addMany(notices);
            if (!stopped)
                for (const entry of entries)
                    stream.publish(entry);
        }
        catch {
            console.warn('[dsh-notify] Notification could not be persisted. Check the state directory.');
        }
    };
    ctx.on('session/event', async (session, event) => {
        const agent = ctx.agents.get(session.id);
        if (!agent)
            return;
        if (ctx.agents.roots().includes(agent))
            rootSessions.add(String(agent.id));
        const title = ctx.get('sessionTitle')?.get(session)?.title;
        const notice = normalizer.observe(String(session.id), title, event, store.state.settings.slack.includeSummary, { workspace: session.header?.cwd, config: session.requestHeader?.()?.config });
        if (!notice)
            return;
        notice.isSubagent = !rootSessions.has(String(agent.id));
        if (notice.kind === 'approval' || agent.status === 'idle')
            await emit(notice);
        else
            gate.enqueue(notice);
    });
    ctx.on('user-questions/request', async (request, next) => {
        const sessionId = String(request.agent?.id ?? 'agentless');
        await emit({ id: `${sessionId}:question:${randomUUID()}`, kind: 'question', sessionId,
            title: `Session ${sessionId}`, time: Date.now(), isSubagent: !!request.agent && !ctx.agents.roots().some(agent => String(agent.id) === sessionId) });
        return next();
    }, { prepend: true });
    ctx.on('agent/status', async ({ agent, status }) => {
        if (status !== 'idle')
            return;
        await emit(...gate.flush(String(agent.id)));
    });
    ctx.on('agent/disposed', async ({ agent }) => {
        normalizer.forget(String(agent.id));
        // A terminal event may be followed by disposal without another idle transition.
        await emit(...gate.flush(String(agent.id)));
        rootSessions.delete(String(agent.id));
    });
    ctx.effect(() => {
        queue.start();
        pricing.start();
        return async () => {
            stopped = true;
            queue.dispose();
            stream.dispose();
            pricing.dispose();
            await Promise.all([store.close(), pricing.close()]);
        };
    }, 'dsh-notify: deliveries');
    ctx.inject(['webServer', 'connection'], web => {
        if (typeof web.connection.requestRejection !== 'function') {
            console.warn('[dsh-notify] Browser delivery requires DSH Connection.requestRejection (tested with 0.2.0-rc.2).');
            return;
        }
        web.effect(() => registerApi(web.webServer, web.connection, store, stream, queue), 'dsh-notify: authenticated API');
    });
}
