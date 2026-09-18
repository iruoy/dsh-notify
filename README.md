# DSH Notify

Browser and Slack notifications for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Get notified when a task finishes, fails, or needs attention.

Browser notifications appear on the computer viewing DSH, even when DSH runs on a remote server. Slack notifications continue when no browser is connected.

## Requirements

- DeepSeek Harness with the **0.1.5-rc.2 API**.
- Node.js **22.19+ or 24+**.
- For browser notifications: a desktop browser supporting Notifications, Web Locks, and EventSource, using HTTPS or HTTP on localhost.
- For Slack notifications: a Slack incoming webhook URL.

## Installation

```sh
dsh plugin --profile web add github:iruoy/dsh-notify
dsh web
```

The repository includes compiled files, so installation requires no build step.

## Setup

Open **Settings → DSH Notify**.

### Browser notifications

1. Click **Enable notifications** and allow the browser permission prompt.
2. Choose which events should produce browser notifications.
3. Click **Save settings**.
4. Click **Send test notification** to check delivery.

Keep at least one DSH tab open to receive notifications. Multiple tabs in the same browser profile produce one notification per event. Clicking a notification focuses DSH and opens the session.

If permission is blocked, allow notifications in the browser's site settings. Operating-system notification settings may also silence notifications.

### Slack notifications

1. Paste an incoming webhook URL into the webhook field.
2. Set **DSH base URL** to the address used to access DSH, such as `https://dsh.example.com`.
3. Choose which events should be sent to Slack.
4. Click **Save settings**, then **Send Slack test**.

Messages include the event, session title, duration when available, and an **Open in DSH** link when a base URL is configured. The base URL defaults to the current browser origin when settings are saved.

To replace a webhook, enter the new URL and save. Leaving the field blank keeps the existing webhook. To remove it, click **Remove webhook**, then save.

## Events

All seven events are enabled by default for both destinations. Browser and Slack event selections are independent.

| Event | Notification |
| --- | --- |
| `completed` | Task completed |
| `error` | Task failed |
| `aborted` | Task aborted |
| `blocked` | Task blocked |
| `max-tokens` | Token limit reached |
| `interrupted` | DSH reports an interrupted turn during recovery |
| `approval` | Approval requested |

**Notify for subagents** is off by default. Enable it to receive notifications for child agents as well.

**Include response summaries in Slack** is also off by default. Enabling it adds up to 1,500 characters of assistant response text. Summaries may contain code or sensitive task details. Session titles are included regardless of this setting.

Test buttons work independently of event selections.

## Delivery history and retries

**Recent deliveries** shows the last 20 events, browser and Slack delivery status, and retry or error details.

- Browser connections can replay missed notifications from the last 200 stored events after reconnecting. A first-time browser starts with new events.
- Slack keeps a persistent queue of up to 100 pending notifications, which survives DSH restarts.
- Network failures, rate limits, and Slack server errors retry up to six total attempts. Rate-limit responses respect Slack's requested retry delay.
- Removing or replacing a webhook, disabling Slack, or deselecting an event cancels affected pending deliveries. Requests already in flight may still arrive.

Browser delivery status indicates that a browser accepted the notification; the operating system may still suppress it. Sleeping computers and suspended tabs can delay delivery. Separate devices or browser profiles can each receive a copy.

A crash immediately after Slack accepts a message can cause that message to be sent again after restart.

## Storage and remote access

Settings, the webhook, pending deliveries, and history are stored in:

```text
$DSH_HOME/dsh-notify/state.json
```

Without `DSH_HOME`, the default is `~/.dsh/dsh-notify/state.json`. State files have owner-only read/write permissions. The saved webhook is never returned to the browser; settings show only whether one is configured.

Use a separate state directory for each DSH instance. Optional Cordis configuration:

```yaml
- id: dsh-notify
  name: dsh-notify
  config:
    dataDir: /path/to/private/dsh-notify-state
    baseUrl: https://dsh.example.com
```

`baseUrl` initializes new settings. Once settings have been saved, update the URL through **Settings → DSH Notify**.

Remote access uses DSH's existing authentication and trusted-host configuration. Reverse proxies must pass authentication cookies and support unbuffered SSE connections. Authenticated users of the same DSH instance share notification settings and history.

## License

[MIT](LICENSE).
