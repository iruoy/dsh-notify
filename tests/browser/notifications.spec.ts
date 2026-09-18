import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { build } from 'esbuild';
import { fixture, notice } from '../fixtures.js';
import { registerApi, type WebServer } from '../../src/api.js';
import { BrowserStream } from '../../src/browser.js';
import { SlackQueue } from '../../src/webhook.js';

let server: Server, base: string, f: ReturnType<typeof fixture>, stream: BrowserStream, queue: SlackQueue, stopApi: () => void;
test.beforeAll(async () => {
  f = fixture(false); stream = new BrowserStream(f.store); queue = new SlackQueue(f.store);
  const routes = new Map<string, Parameters<WebServer['register']>[0]['handler']>();
  stopApi = registerApi({ register: r => { routes.set(r.path, r.handler); return () => routes.delete(r.path); } }, { requestRejection: () => undefined }, f.store, stream, queue);
  const bundle = await build({ entryPoints: ['tests/browser/page.tsx'], bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' } });
  server = createServer((req, res) => {
    const path = new URL(req.url!, 'http://localhost').pathname;
    const handler = routes.get(path);
    if (handler) { void handler(req, res); return; }
    if (path === '/app.js') { res.setHeader('content-type', 'application/javascript'); res.end(bundle.outputFiles[0].text); return; }
    res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>DSH Notify</title></head><body style="margin:0;padding:24px;background:#fff;color:#262626;font-family:Arial,sans-serif"><div id="root"></div><script src="/app.js"></script></body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
test.afterAll(async () => { stopApi(); queue.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); f.cleanup(); });
test('settings, permission gesture, one notification across tabs, click, replay and leader failover', async ({ context, page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  // Record browser API calls; no real OS notifications or external Slack posts in tests.
  await context.addInitScript(() => {
    (window as any).notices = [];
    class MockNotification {
      static permission = localStorage.getItem('permission') || 'default';
      static requestPermission() {
        (window as any).permissionGesture = navigator.userActivation.isActive;
        MockNotification.permission = 'granted'; localStorage.setItem('permission', 'granted'); return Promise.resolve('granted');
      }
      onclick?: () => void;
      constructor(public title: string, public options: object) { (window as any).notices.push(this); }
      close() {}
    }
    Object.defineProperty(window, 'Notification', { value: MockNotification, configurable: true });
  });
  await page.goto(base);
  await expect(page.getByRole('heading', { name: 'DSH Notify' })).toBeVisible();
  await page.getByRole('button', { name: 'Enable notifications', exact: true }).click();
  expect(await page.evaluate(() => (window as any).permissionGesture)).toBe(true);
  await expect(page.getByText(/Appears on this computer/)).toContainText('Connected');
  await page.getByRole('button', { name: 'Send test notification', exact: true }).click();
  expect(await page.evaluate(() => (window as any).notices.length)).toBe(1);
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Settings saved.');
  expect(f.store.view().baseUrl).toBe(base);
  const second = await context.newPage(); await second.goto(base);
  await expect(second.getByRole('heading', { name: 'DSH Notify' })).toBeVisible();
  const firstEntry = f.store.add(notice('browser-1'))!; stream.publish(firstEntry);
  await expect.poll(() => page.evaluate(() => (window as any).notices.length)).toBe(2);
  expect(await second.evaluate(() => (window as any).notices.length)).toBe(0);
  await page.evaluate(() => (window as any).notices[1].onclick());
  expect(await page.evaluate(() => (window as any).openedSession)).toBe('s');
  await expect.poll(() => f.store.history()[0].browser).toBe('delivered');
  await page.screenshot({ path: 'test-results/settings-desktop.png', fullPage: true });
  await page.addStyleTag({ content: `body{background:#292929!important;color:#f5f5f5!important;--dsw-alias-label-primary:#f5f5f5;--dsw-alias-label-tertiary:#aaa;--dsw-alias-border-l2:#ffffff1f;--dsw-alias-border-l4:#ffffff29;--dsw-alias-bg-layer-3:#333;--dsw-alias-brand-primary:#4d6bfe}` });
  await page.screenshot({ path: 'test-results/settings-dark.png', fullPage: true });
  await page.close();
  await expect(second.getByText(/Appears on this computer/)).toContainText('Connected');
  const next = f.store.add(notice('browser-2'))!; stream.publish(next);
  await expect.poll(() => second.evaluate(() => (window as any).notices.length)).toBe(1);
  await expect.poll(() => f.store.history()[0].browser).toBe('delivered');
  await second.close();
  // No browser is connected; next tab replays only the missed event from persisted cursor.
  stream.publish(f.store.add(notice('offline'))!);
  const third = await context.newPage(); await third.goto(base + '/?dsh-notify-session=linked-session');
  await expect.poll(() => third.evaluate(() => (window as any).notices.length)).toBe(1);
  expect(await third.evaluate(() => (window as any).openedSession)).toBe('linked-session');
  expect(third.url()).not.toContain('dsh-notify-session');
  await third.setViewportSize({ width: 390, height: 844 });
  await third.screenshot({ path: 'test-results/settings-mobile.png', fullPage: true });
  expect(await third.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
