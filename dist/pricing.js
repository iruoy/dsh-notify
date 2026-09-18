import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
export const PRICING_URL = 'https://models.dev/api.json';
export const PRICING_TTL = 24 * 60 * 60 * 1000;
export function publicPricingProvider(provider) {
    if (provider === 'codex')
        return 'openai';
    if (provider === 'claude' || provider === 'claude-code')
        return 'anthropic';
    return provider;
}
const RETRY_INTERVAL = 60 * 60 * 1000;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const amount = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
function rates(value) {
    if (!object(value) || !amount(value.input) || !amount(value.output))
        return;
    if (value.cache_read !== undefined && !amount(value.cache_read) || value.cache_write !== undefined && !amount(value.cache_write))
        return;
    return { input: value.input, output: value.output, ...(value.cache_read !== undefined ? { cache_read: value.cache_read } : {}), ...(value.cache_write !== undefined ? { cache_write: value.cache_write } : {}) };
}
function price(value, cached = false) {
    const base = rates(value);
    if (!base || !object(value))
        return;
    const tiers = [];
    if (value.tiers !== undefined) {
        if (!Array.isArray(value.tiers))
            return;
        for (const entry of value.tiers) {
            if (!object(entry))
                return;
            const tierRates = rates(entry);
            const threshold = cached ? entry.threshold : object(entry.tier) && entry.tier.type === 'context' ? entry.tier.size : undefined;
            if (!tierRates || !amount(threshold))
                return; // Unsupported tier semantics must not silently use base prices.
            tiers.push({ ...tierRates, threshold });
        }
    }
    else if (!cached && value.context_over_200k !== undefined) {
        const tierRates = rates(value.context_over_200k);
        if (!tierRates)
            return;
        tiers.push({ ...tierRates, threshold: 200_000 });
    }
    return { ...base, ...(tiers.length ? { tiers: tiers.sort((a, b) => a.threshold - b.threshold) } : {}) };
}
function parsePrices(value, cached = false) {
    if (!object(value))
        throw new Error('Invalid pricing catalog');
    const prices = {};
    for (const provider of ['openai', 'anthropic']) {
        const entry = value[provider];
        const models = cached ? entry : object(entry) ? entry.models : undefined;
        if (!object(models))
            throw new Error('Missing provider prices');
        const valid = Object.entries(models).flatMap(([model, data]) => {
            const parsed = price(cached ? data : object(data) ? data.cost : undefined, cached);
            return parsed ? [[model, parsed]] : [];
        });
        if (!valid.length)
            throw new Error('Empty provider prices');
        prices[provider] = Object.fromEntries(valid);
    }
    return prices;
}
/** Public list prices only. Network and cache failures never block notifications. */
export class PricingCache {
    directory;
    fetcher;
    now;
    snapshot;
    pending;
    nextAttempt = 0;
    stopped = false;
    timer;
    controller = new AbortController();
    path;
    constructor(directory, fetcher = fetch, now = Date.now) {
        this.directory = directory;
        this.fetcher = fetcher;
        this.now = now;
        this.path = join(directory, 'pricing.json');
        try {
            const raw = JSON.parse(readFileSync(this.path, 'utf8'));
            if (object(raw) && raw.version === 1 && amount(raw.fetchedAt) && raw.fetchedAt <= this.now()) {
                this.snapshot = { version: 1, fetchedAt: raw.fetchedAt, prices: parsePrices(raw.prices, true) };
            }
        }
        catch { /* A missing or corrupt cache is rebuilt in the background. */ }
    }
    start() {
        void this.refresh();
        this.timer = setInterval(() => { void this.refresh(); }, RETRY_INTERVAL);
        this.timer.unref();
    }
    dispose() { this.stopped = true; clearInterval(this.timer); this.controller.abort(); }
    refresh() {
        if (this.pending)
            return this.pending;
        const now = this.now();
        if (this.stopped || now < this.nextAttempt || this.snapshot && now - this.snapshot.fetchedAt < PRICING_TTL)
            return Promise.resolve();
        this.nextAttempt = now + RETRY_INTERVAL;
        this.pending = this.download().finally(() => { this.pending = undefined; });
        return this.pending;
    }
    async download() {
        let temp;
        try {
            const response = await this.fetcher(PRICING_URL, { redirect: 'error', signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15_000)]) });
            if (!response.ok || !response.body) {
                await response.body?.cancel();
                return;
            }
            const chunks = [];
            let bytes = 0;
            for await (const chunk of response.body) {
                bytes += chunk.byteLength;
                if (bytes > 20 * 1024 * 1024)
                    throw new Error('Pricing catalog too large');
                chunks.push(chunk);
            }
            const prices = parsePrices(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            if (this.stopped)
                return;
            const snapshot = { version: 1, fetchedAt: this.now(), prices };
            mkdirSync(this.directory, { recursive: true, mode: 0o700 });
            temp = `${this.path}.${randomUUID()}.tmp`;
            writeFileSync(temp, JSON.stringify(snapshot), { mode: 0o600, flag: 'wx' });
            renameSync(temp, this.path);
            this.snapshot = snapshot;
        }
        catch { /* Keep the last successful snapshot and retry in an hour. */ }
        finally {
            if (temp) {
                try {
                    rmSync(temp, { force: true });
                }
                catch { /* Best effort cleanup. */ }
            }
        }
    }
    estimate = (provider, model, usage) => {
        const snapshot = this.snapshot;
        // Known subscription/CLI routes use public API rates for the exact model ID.
        const pricingProvider = publicPricingProvider(provider);
        const models = snapshot && Object.hasOwn(snapshot.prices, pricingProvider) ? snapshot.prices[pricingProvider] : undefined;
        if (!snapshot || !models || !Object.hasOwn(models, model))
            return;
        const route = models[model];
        const input = usage.inputTokens, output = usage.outputTokens, read = usage.cacheReadTokens ?? 0, write = usage.cacheWriteTokens ?? 0;
        if (![input, output, read, write].every(n => Number.isSafeInteger(n) && n >= 0))
            return;
        // DSH inputTokens excludes cache reads/writes; reasoning is already included in output.
        const context = input + read + write;
        const selected = route.tiers?.findLast(tier => context > tier.threshold) ?? route;
        if (read && selected.cache_read === undefined || write && selected.cache_write === undefined)
            return;
        const usd = (input * selected.input + output * selected.output + read * (selected.cache_read ?? 0) + write * (selected.cache_write ?? 0)) / 1_000_000;
        if (!Number.isFinite(usd))
            return;
        return { usd, fetchedAt: snapshot.fetchedAt, stale: this.now() - snapshot.fetchedAt >= PRICING_TTL };
    };
}
