import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import { BrowserRuntime } from './runtime.js';
import { SettingsSection } from './settings.js';
import { styles } from './styles.js';

export const inject = ['slots', 'uiWorkspace'];
export function apply(ctx: Context): void {
  const open = (id: string) => ctx.uiWorkspace.openSession(id as SessionId);
  ctx.effect(() => {
    const runtime = new BrowserRuntime(open);
    runtime.start();
    const style = document.createElement('style'); style.textContent = styles; document.head.appendChild(style);
    const unregister = ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section', id: 'dsh-notify', order: 35, label: 'DSH Notify', inject: () => ({ runtime }),
    }, SettingsSection));
    // A plugin-owned query parameter makes Slack links independent of DSH's internal routing.
    const url = new URL(window.location.href), id = url.searchParams.get('dsh-notify-session');
    if (id) { open(id); url.searchParams.delete('dsh-notify-session'); history.replaceState(history.state, '', url); }
    return () => { unregister(); runtime.dispose(); style.remove(); };
  }, 'dsh-notify: browser');
}
