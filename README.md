# DSH Notify

Browser and Slack notifications for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Get notified when a task finishes, fails, or needs attention.

Browser notifications appear on the computer viewing DSH, even when DSH runs on a remote server. Slack notifications continue when no browser is connected.

## Requirements

- DeepSeek Harness with the **0.1.7-rc.2 API**.
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

Open **Settings → Notify**.

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

Messages include the event, session title, workspace path, human input (up to 1,500 characters), duration, model/provider, reasoning effort, and per-turn token usage when available, plus an **Open in DSH** link when a base URL is configured. Human input is included independently of the optional response summary; injected instructions and tool results are excluded. The base URL defaults to the current browser origin when settings are saved.

Token usage is grouped by model and effort, including reported usage from failed attempts. Input, output, and cache counters are shown separately; a total is shown only when DSH supplies it for every reported call. Missing usage is marked as partial, and missing effort is shown as “Not reported”. Counts cover the observed turn, not the whole session or its subagents.

To replace a webhook, enter the new URL and save. Leaving the field blank keeps the existing webhook. To remove it, click **Remove webhook**, then save.

### Estimated API cost

Slack notifications also show an **estimated API cost in USD** for exact `openai` and `anthropic` provider/model matches in the [Models.dev public catalog](https://models.dev). DSH’s `codex` provider is mapped to `openai`; `claude` and `claude-code` are mapped to `anthropic`. These routes use exact model IDs and are labeled **Estimated API-equivalent cost**, since public API rates do not represent subscription billing. No API key is required. Prices are community-maintained public list rates, not your billed amount or subscription cost; custom routes, discounts, service tiers, and separately billed tools are not accounted for.

The plugin downloads `https://models.dev/api.json` in the background on startup when its cache is missing or more than 24 hours old, then checks hourly for a refresh. Validated prices are saved in `pricing.json` beside `state.json`, so they survive restarts. Failed refreshes keep the last successful cache and retry after an hour. Notifications never wait for pricing downloads: unavailable prices are marked **Unavailable**, and prices more than 24 hours old are marked **stale cache**.

Each reported call is priced separately using uncached input, output, cache-read, and cache-write counts and applicable catalog context-size tiers. Reasoning tokens are not added again to output tokens. Missing models, rates, or usage are never treated as free: partial estimates show how many calls could be priced. The per-turn estimate is saved with the notification so retries and restarts preserve the original amount. Prices are downloaded without sending prompts, session information, or token usage to Models.dev.

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
- On upgrade, queued task completions without an agent classification are cancelled, including main-task completions: older records cannot distinguish them from subagents. Identified main-task completions and other event types remain queued; subagent completions are cancelled.
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

`baseUrl` initializes new settings. Once settings have been saved, update the URL through **Settings → Notify**.

Remote access uses DSH's existing authentication and trusted-host configuration. Reverse proxies must pass authentication cookies and support unbuffered SSE connections. Authenticated users of the same DSH instance share notification settings and history.

## Development

Settings controls use `Button`, `Input`, and `Switch` from DSH's shared UI primitives, supplied by the host browser module loader. Local CSS handles section layout and delivery history; it does not override those controls.

The primitives package and its browser build dependencies are development-only: Playwright bundles the real components and their CSS for testing. The shipped plugin keeps the primitives import external and uses DSH's installed components and theme.

Run `npm run check` and `npm run test:browser` before shipping changes.

## License

[MIT](LICENSE).
