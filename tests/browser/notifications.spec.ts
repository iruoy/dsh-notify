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
  const bundle = await build({ entryPoints: ['tests/browser/page.tsx'], bundle: true, write: false, outfile: 'app.js', loader: { '.module.css': 'local-css', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' }, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' } });
  server = createServer((req, res) => {
    const path = new URL(req.url!, 'http://localhost').pathname;
    const handler = routes.get(path);
    if (handler) { void handler(req, res); return; }
    if (path === '/app.js') { res.setHeader('content-type', 'application/javascript'); res.end(bundle.outputFiles.find(file => file.path.endsWith('/app.js'))!.text); return; }
    if (path === '/app.css') { res.setHeader('content-type', 'text/css'); res.end(bundle.outputFiles.find(file => file.path.endsWith('/app.css'))!.text); return; }
    res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>DSH Notify</title><link rel="stylesheet" href="/app.css"><style>:root{--dsw-alias-label-primary:#262626;--dsw-alias-label-tertiary:#777;--dsw-alias-label-dimmed:#888;--dsw-alias-border-l2:#ddd;--dsw-alias-border-l3:#ccc;--dsw-alias-border-l4:#bbb;--dsw-alias-bg-layer-1:#fff;--dsw-alias-brand-primary:#0f1115;--dsw-alias-button-primary-fill:#0f1115;--dsw-alias-button-primary-hover:#43454a;--dsw-alias-label-primary-foreground:#fff}</style></head><body style="margin:0;padding:24px;background:#fff;color:#262626;font-family:Arial,sans-serif"><div id="root"></div><script src="/app.js"></script></body></html>');
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
  await expect(page.getByRole('heading', { name: 'Notify', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Enable notifications', exact: true }).click();
  expect(await page.evaluate(() => (window as any).permissionGesture)).toBe(true);
  await expect(page.getByRole('button', { name: 'Enable notifications', exact: true })).toBeHidden();
  await expect(page.getByText(/Appears on this computer/)).toContainText('Connected');
  await page.getByRole('button', { name: 'Send test notification', exact: true }).click();
  expect(await page.evaluate(() => (window as any).notices.length)).toBe(1);
  const failedEvent = page.getByRole('switch', { name: 'Browser: Task failed', exact: true });
  await expect(failedEvent).toBeChecked();
  await failedEvent.click();
  await expect(failedEvent).not.toBeChecked();
  await page.getByLabel('DSH base URL', { exact: true }).fill(base);
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Settings saved.');
  expect(f.store.view().baseUrl).toBe(base);
  expect(f.store.view().browser.events.error).toBe(false);
  await page.getByRole('button', { name: 'Reload saved settings', exact: true }).click();
  await expect(failedEvent).not.toBeChecked();
  const second = await context.newPage(); await second.goto(base);
  await expect(second.getByRole('heading', { name: 'Notify', exact: true })).toBeVisible();
  await expect(second.getByRole('button', { name: 'Enable notifications', exact: true })).toBeHidden();
  const firstEntry = f.store.add(notice('browser-1'))!; stream.publish(firstEntry);
  await expect.poll(() => page.evaluate(() => (window as any).notices.length)).toBe(2);
  expect(await second.evaluate(() => (window as any).notices.length)).toBe(0);
  await page.evaluate(() => (window as any).notices[1].onclick());
  expect(await page.evaluate(() => (window as any).openedSession)).toBe('s');
  await expect.poll(() => f.store.history()[0].browser).toBe('delivered');
  await page.mouse.move(0, 0);
  const saveButton = page.getByRole('button', { name: 'Save settings', exact: true });
  await expect(saveButton).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect(saveButton).toHaveCSS('background-color', 'rgb(15, 17, 21)');
  await page.screenshot({ path: 'test-results/settings-desktop.png', fullPage: true });
  await page.addStyleTag({ content: `body{background:#292929!important;color:#f5f5f5!important;--dsw-alias-label-primary:#f5f5f5;--dsw-alias-label-tertiary:#aaa;--dsw-alias-border-l2:#ffffff1f;--dsw-alias-border-l4:#ffffff29;--dsw-alias-bg-layer-1:#212121;--dsw-alias-bg-layer-3:#333;--dsw-alias-border-l3:#555;--dsw-alias-brand-primary:#f9fafb;--dsw-alias-button-primary-fill:#f9fafb;--dsw-alias-button-primary-hover:#ebeef2;--dsw-alias-label-primary-foreground:#0f1115}` });
  // DSH's primary fill becomes near-white in dark mode; its foreground must invert too.
  await expect(saveButton).toHaveCSS('color', 'rgb(15, 17, 21)');
  await expect(saveButton).toHaveCSS('background-color', 'rgb(249, 250, 251)');
  await saveButton.hover();
  await expect(saveButton).toHaveCSS('background-color', 'rgb(235, 238, 242)');
  await expect(saveButton).toHaveCSS('color', 'rgb(15, 17, 21)');
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
