import { useEffect, useState, useSyncExternalStore } from 'react';
import { Button, Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives';
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import { KINDS, LABELS, type EventSwitches, type HistoryEntry, type Settings, type SettingsView } from '../types.js';
import { BrowserRuntime, permissionStatus, request } from './runtime.js';

export interface Injected { runtime: BrowserRuntime }
type Props = PropsRuntime<'settings.section'> & InjectFace<Injected>;
function EventChoices({ value, onChange, destination }: { value: EventSwitches; onChange: (v: EventSwitches) => void; destination: string }) {
  return <div className="dn-events">{KINDS.map(kind => <label key={kind} className="dn-choice"><span>{LABELS[kind]}</span><Switch checked={value[kind]} label={`${destination}: ${LABELS[kind]}`} onChange={checked => onChange({ ...value, [kind]: checked })} /></label>)}</div>;
}
export function SettingsSection({ runtime }: Props) {
  const [view, setView] = useState<SettingsView>();
  const [settings, setSettings] = useState<Settings>();
  const [webhook, setWebhook] = useState('');
  const [removeWebhook, setRemoveWebhook] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [permission, setPermission] = useState(permissionStatus);
  const connection = useSyncExternalStore(runtime.subscribe, runtime.snapshot);
  const reload = async () => {
    const next = await request<SettingsView>('/settings'); setView(next);
    const { revision: _revision, webhookConfigured: _configured, ...current } = next;
    setSettings({ ...current, baseUrl: current.baseUrl || window.location.origin });
    setWebhook(''); setRemoveWebhook(false);
  };
  useEffect(() => {
    let alive = true;
    void reload().catch(e => { if (alive) setMessage(e.message); });
    const poll = () => request<HistoryEntry[]>('/history').then(rows => { if (alive) setHistory(rows); }).catch(() => {});
    void poll(); const timer = setInterval(poll, 5000);
    const focus = () => setPermission(permissionStatus()); window.addEventListener('focus', focus);
    return () => { alive = false; clearInterval(timer); window.removeEventListener('focus', focus); };
  }, []);
  const action = async (fn: () => Promise<void>) => {
    setBusy(true); setMessage(''); try { await fn(); } catch (e) { setMessage(e instanceof Error ? e.message : 'Request failed.'); } finally { setBusy(false); }
  };
  const save = async () => {
    if (!settings || !view) return;
    const next = await request<SettingsView>('/settings', 'PUT', {
      revision: view.revision, settings,
      ...(removeWebhook ? { webhook: null } : webhook.trim() ? { webhook: webhook.trim() } : {}),
    });
    setView(next); setWebhook(''); setRemoveWebhook(false); setMessage('Settings saved.');
  };
  return <section className="dn" aria-label="Notify settings">
    <div className="dn-heading"><h2>Notify</h2><p className="dn-muted">Choose when to receive browser and Slack notifications.</p></div>
    <div role="status" className="dn-message">{message}</div>
    {!settings || !view ? <Button variant="outline" onClick={() => void action(reload)}>Reload settings</Button> : <>
      <fieldset disabled={busy}><legend>Browser</legend>
        <div className="dn-row"><label className="dn-choice"><span>Browser notifications</span><Switch checked={settings.browser.enabled} label="Browser notifications" onChange={checked => setSettings({ ...settings, browser: { ...settings.browser, enabled: checked } })} /></label><span className="dn-muted">{permission}</span></div>
        <p className="dn-muted">Appears on this computer while a DSH tab is open. {connection}.</p>
        <div className="dn-actions"><Button variant="outline" type="button" disabled={!('Notification' in window) || !window.isSecureContext} onClick={() => {
          // Call directly in the user gesture, before any network request or await.
          if ('Notification' in window) void Notification.requestPermission().then(() => { setPermission(permissionStatus()); runtime.refresh(); }).catch(() => setMessage('The browser could not request notification permission.'));
        }}>Enable notifications</Button><Button variant="outline" type="button" onClick={() => void action(async () => { runtime.test(); setMessage('Test notification sent to this browser.'); })}>Send test notification</Button></div>
        <EventChoices destination="Browser" value={settings.browser.events} onChange={events => setSettings({ ...settings, browser: { ...settings.browser, events } })} />
      </fieldset>
      <fieldset disabled={busy}><legend>Slack</legend>
        <div className="dn-row"><label className="dn-choice"><span>Slack notifications</span><Switch checked={settings.slack.enabled} label="Slack notifications" onChange={checked => setSettings({ ...settings, slack: { ...settings.slack, enabled: checked } })} /></label><span className="dn-muted">{removeWebhook ? 'Will be removed on save' : view.webhookConfigured ? 'Webhook configured' : 'No webhook configured'}</span></div>
        <label className="dn-field">{view.webhookConfigured ? 'Replace webhook' : 'Incoming webhook URL'}<Input type="password" autoComplete="off" spellCheck={false} placeholder="https://hooks.slack.com/services/…" value={webhook} onChange={e => { setWebhook(e.target.value); setRemoveWebhook(false); }} /></label>
        <p className="dn-muted">Stored privately on the DSH host. The saved URL is never returned to your browser.</p>
        <div className="dn-actions"><Button variant="outline" type="button" disabled={!view.webhookConfigured} onClick={() => { setRemoveWebhook(!removeWebhook); setWebhook(''); }}>{removeWebhook ? 'Keep webhook' : 'Remove webhook'}</Button><Button variant="outline" type="button" disabled={!view.webhookConfigured || !!webhook || removeWebhook} onClick={() => void action(async () => { await request('/test-slack', 'POST'); setMessage('Slack accepted the test notification.'); })}>Send Slack test</Button></div>
        <EventChoices destination="Slack" value={settings.slack.events} onChange={events => setSettings({ ...settings, slack: { ...settings.slack, events } })} />
        <label className="dn-choice"><span>Include response summaries in Slack</span><Switch checked={settings.slack.includeSummary} label="Include response summaries in Slack" onChange={checked => setSettings({ ...settings, slack: { ...settings.slack, includeSummary: checked } })} /></label>
        <p className="dn-muted">Off by default. Summaries may contain code or sensitive task details.</p>
      </fieldset>
      <fieldset disabled={busy}><legend>General</legend>
        <label className="dn-field">DSH base URL<Input type="url" value={settings.baseUrl} placeholder={window.location.origin} onChange={e => setSettings({ ...settings, baseUrl: e.target.value })} /></label>
        <p className="dn-muted">Used by “Open in DSH” in Slack. Defaults to this browser’s origin when you save.</p>
        <label className="dn-choice"><span>Notify for subagents</span><Switch checked={settings.notifySubagents} label="Notify for subagents" onChange={checked => setSettings({ ...settings, notifySubagents: checked })} /></label>
      </fieldset>
      <div className="dn-actions"><Button variant="primary" disabled={busy} onClick={() => void action(save)}>{busy ? 'Working…' : 'Save settings'}</Button><Button variant="outline" disabled={busy} onClick={() => void action(reload)}>Reload saved settings</Button></div>
      <h3>Recent deliveries <span className="dn-muted">Last 20</span></h3>
      <p className="dn-muted">Browser “delivered” means a browser accepted the notification. Your operating system may still silence it.</p>
      {!history.length ? <p className="dn-empty">No notifications yet. Your next task event will appear here.</p> : <div className="dn-table"><table><thead><tr><th>Event</th><th>Time</th><th>Browser</th><th>Slack</th></tr></thead><tbody>{history.map(h => <tr key={h.seq}><td><strong>{LABELS[h.notice.kind]}</strong><div className="dn-muted">{h.notice.title}</div>{h.error && <div className="dn-error">{h.error}</div>}</td><td>{new Date(h.notice.time).toLocaleTimeString()}</td><td>{h.browser}</td><td>{h.slack}{h.attempts > 0 && <div className="dn-muted">{h.attempts} attempt{h.attempts === 1 ? '' : 's'}</div>}{h.nextAttempt && <div className="dn-muted">Retry {new Date(h.nextAttempt).toLocaleTimeString()}</div>}</td></tr>)}</tbody></table></div>}
    </>}
  </section>;
}
