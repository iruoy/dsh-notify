import { KINDS } from './types.js';
function text(content) {
    return content.flatMap(block => {
        if (!block || typeof block !== 'object')
            return [];
        const b = block;
        return b.type === 'text' && typeof b.text === 'string' ? [b.text] : [];
    }).join('\n');
}
function noticeBase(sessionId, title, time, context) {
    // Do not send prompts or error/approval details as title fallbacks.
    return { sessionId, title: (title || `Session ${sessionId}`).slice(0, 200), time,
        ...(context.workspace ? { workspace: context.workspace.slice(0, 1000) } : {}) };
}
/** Incrementally fold committed events, without depending on DSH's removed session.events API. */
export class EventNormalizer {
    priceCall;
    turns = new Map();
    constructor(priceCall) {
        this.priceCall = priceCall;
    }
    observe(sessionId, title, event, includeSummary, context = {}) {
        switch (event.type) {
            case 'turn/start':
                this.startTurn(sessionId, event.data.turn, event.time);
                return;
            case 'user/message':
                this.appendHumanInput(this.turns.get(sessionId), event);
                return;
            case 'assistant/message':
            case 'assistant/attempt':
                this.recordAssistant(this.turns.get(sessionId), event, includeSummary, context);
                return;
            case 'approval/asked': {
                const active = this.turns.get(sessionId);
                return { ...noticeBase(sessionId, title, event.time, context), id: `${sessionId}:approval:${event.data.id}`, kind: 'approval',
                    ...(active?.input ? { input: active.input } : {}) };
            }
            case 'turn/end': return this.finishTurn(noticeBase(sessionId, title, event.time, context), event, includeSummary);
            default: return;
        }
    }
    startTurn(sessionId, turn, started) {
        this.turns.set(sessionId, { turn, started, summary: '', input: '', runs: [], complete: true,
            ...(this.priceCall ? { cost: { usd: 0, calls: 0, pricedCalls: 0, stale: false } } : {}) });
    }
    appendHumanInput(active, event) {
        // Only human input, never injected instructions, tool results, or surface rewrites.
        if (active && event.data.source?.kind === 'user' && event.surfaceOp === 'append') {
            active.input = (active.input + '\n' + text(event.data.content)).trim().slice(0, 1500);
        }
    }
    recordAssistant(active, event, includeSummary, context) {
        if (!active || active.turn !== event.data.turn)
            return;
        const config = context.config;
        const source = event.type === 'assistant/message' ? event.data.message.source : config;
        const provider = source?.provider, model = source?.model;
        const effort = config && config.provider === provider && config.model === model ? config.reasoningEffort : undefined;
        if (active.cost)
            active.cost.calls++;
        if (!provider || !model)
            active.complete = false;
        else {
            const run = this.runFor(active, provider, model, effort);
            // Attempt streams may contain a final usage snapshot; never sum cumulative snapshots.
            const reported = event.type === 'assistant/message' ? event.data.usage : event.data.stream
                .flatMap(r => r.type === 'chunk' && r.chunk.type === 'usage' ? [r.chunk.usage] : []).at(-1);
            run.calls++;
            if (reported)
                this.recordUsage(active, run, reported);
            else
                active.complete = false;
        }
        if (event.type === 'assistant/message' && includeSummary)
            active.summary = (active.summary + '\n' + text(event.data.message.content)).trim().slice(0, 1500);
    }
    runFor(active, provider, model, effort) {
        let run = active.runs.find(r => r.provider === provider && r.model === model && r.effort === effort);
        if (!run) {
            run = { provider, model, effort, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, calls: 0, reportedCalls: 0 };
            active.runs.push(run);
        }
        return run;
    }
    recordUsage(active, run, reported) {
        const estimated = this.priceCall?.(run.provider, run.model, reported);
        if (active.cost && estimated) {
            active.cost.usd += estimated.usd;
            active.cost.pricedCalls++;
            active.cost.fetchedAt = Math.min(active.cost.fetchedAt ?? estimated.fetchedAt, estimated.fetchedAt);
            active.cost.stale ||= estimated.stale;
        }
        run.reportedCalls++;
        run.inputTokens += reported.inputTokens;
        run.outputTokens += reported.outputTokens;
        run.cacheReadTokens += reported.cacheReadTokens ?? 0;
        run.cacheWriteTokens += reported.cacheWriteTokens ?? 0;
        // Only the adapter can assert an authoritative full-call total.
        run.totalTokens = run.totalTokens !== undefined && reported.totalTokens !== undefined ? run.totalTokens + reported.totalTokens : undefined;
    }
    finishTurn(base, event, includeSummary) {
        const active = this.turns.get(base.sessionId);
        const matched = active?.turn === event.data.turn ? active : undefined;
        if (matched)
            this.turns.delete(base.sessionId);
        const kind = event.data.reason.kind;
        if (!KINDS.includes(kind))
            return;
        return { ...base, id: `${base.sessionId}:turn:${event.data.turn}`, kind: kind,
            ...(matched ? { durationMs: Math.max(0, event.time - matched.started), input: matched.input || undefined, runs: matched.runs, usageComplete: matched.complete, ...(matched.cost ? { cost: matched.cost } : {}) } : {}),
            ...(matched?.summary && includeSummary ? { summary: matched.summary } : {}) };
    }
    forget(id) { this.turns.delete(id); }
}
/** DSH appends turn/end before setting idle. Hold terminal notifications until idle. */
export class CompletionGate {
    pending = new Map();
    enqueue(notice) {
        const list = this.pending.get(notice.sessionId) ?? [];
        if (!list.some(n => n.id === notice.id))
            list.push(notice);
        this.pending.set(notice.sessionId, list.slice(-20));
    }
    flush(id) { const list = this.pending.get(id) ?? []; this.pending.delete(id); return list; }
}
