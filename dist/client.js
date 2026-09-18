window.__ModuleLoader__.load({ id: "dsh-notify", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.tsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// src/types.ts
var KINDS = ["completed", "error", "aborted", "blocked", "max-tokens", "interrupted", "approval"];
var LABELS = {
  completed: "Task completed",
  error: "Task failed",
  aborted: "Task aborted",
  blocked: "Task blocked",
  "max-tokens": "Token limit reached",
  interrupted: "Task interrupted",
  approval: "Approval requested"
};
var API = "/api/dsh-notify";

// src/client/runtime.ts
async function request(path, method = "GET", data) {
  const response = await fetch(API + path, {
    method,
    credentials: "same-origin",
    headers: { "content-type": "application/json", "x-dsh-notify": "1" },
    ...data === void 0 ? {} : { body: JSON.stringify(data) },
    signal: AbortSignal.timeout(15e3)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}
function permissionStatus() {
  if (!window.isSecureContext) return "HTTPS is required for browser notifications.";
  if (!("Notification" in window)) return "This browser does not support desktop notifications.";
  return Notification.permission === "granted" ? "Enabled" : Notification.permission === "denied" ? "Blocked \u2014 allow notifications in your browser\u2019s site settings." : "Not enabled";
}
var CURSOR = "dsh-notify:cursor:v1";
var BrowserRuntime = class {
  constructor(open) {
    this.open = open;
  }
  open;
  abort = new AbortController();
  release;
  source;
  waiting = false;
  stopped = false;
  listeners = /* @__PURE__ */ new Set();
  channel;
  status = "Not connected";
  subscribe = (fn) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  snapshot = () => this.status;
  setStatus(value) {
    this.status = value;
    for (const listener of this.listeners) listener();
  }
  start() {
    if ("BroadcastChannel" in window) {
      this.channel = new BroadcastChannel("dsh-notify");
      this.channel.onmessage = () => {
        if (!this.source) this.setStatus("Another tab is receiving notifications");
      };
    }
    window.addEventListener("focus", this.refresh);
    this.refresh();
  }
  refresh = () => {
    if (this.stopped) return;
    if (!("Notification" in window) || Notification.permission !== "granted") {
      this.release?.();
      this.setStatus(permissionStatus());
      return;
    }
    if (!navigator.locks) {
      this.setStatus("This browser needs Web Locks support for notification delivery.");
      return;
    }
    if (this.waiting) return;
    this.waiting = true;
    this.setStatus("Waiting for the notification tab");
    void navigator.locks.request("dsh-notify:leader", { signal: this.abort.signal }, async () => {
      if (this.stopped || Notification.permission !== "granted") return;
      await new Promise((resolve) => {
        this.release = resolve;
        this.connect();
      });
      this.source?.close();
      this.source = void 0;
      this.release = void 0;
    }).catch(() => {
      if (!this.stopped) this.setStatus("Could not acquire notification leadership.");
    }).finally(() => {
      this.waiting = false;
    });
  };
  cursor() {
    try {
      const raw = localStorage.getItem(CURSOR);
      if (raw === null) return;
      const value = Number(raw);
      return Number.isSafeInteger(value) && value >= 0 ? value : void 0;
    } catch {
      return;
    }
  }
  saveCursor(seq) {
    try {
      localStorage.setItem(CURSOR, String(seq));
    } catch {
    }
  }
  connect() {
    const after = this.cursor();
    this.source = new EventSource(API + "/events" + (after === void 0 ? "" : `?after=${after}`));
    this.source.onopen = () => {
      this.setStatus("Connected");
      this.channel?.postMessage("leader");
    };
    this.source.onerror = () => this.setStatus("Disconnected \u2014 reconnecting");
    this.source.addEventListener("cursor", (event) => this.saveCursor(Number(event.data)));
    this.source.addEventListener("gap", () => this.setStatus("Replay window exceeded \u2014 check recent deliveries"));
    this.source.addEventListener("notice", (event) => {
      try {
        const { seq, notice } = JSON.parse(event.data);
        if (seq <= (this.cursor() ?? -1)) return;
        let delivered = false;
        try {
          this.show(notice);
          delivered = true;
        } catch {
          this.setStatus("Notification could not be shown. Check browser permissions.");
        }
        this.saveCursor(seq);
        void request("/ack", "POST", { seq, delivered }).catch(() => this.setStatus("Notification receipt could not be saved"));
      } catch {
        this.setStatus("Invalid notification received");
      }
    });
  }
  show(notice) {
    if (Notification.permission !== "granted") throw new Error("Enable browser notifications first.");
    const notification = new Notification(LABELS[notice.kind], { body: notice.title, tag: `dsh-notify:${notice.id}` });
    notification.onclick = () => {
      window.focus();
      if (notice.sessionId) this.open(notice.sessionId);
      notification.close();
    };
  }
  test() {
    this.show({ id: "test", kind: "completed", title: "DSH Notify is ready.", sessionId: "", time: Date.now() });
  }
  dispose() {
    this.stopped = true;
    this.abort.abort();
    this.release?.();
    this.source?.close();
    this.channel?.close();
    window.removeEventListener("focus", this.refresh);
    this.listeners.clear();
  }
};

// src/client/settings.tsx
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
function EventChoices({ value, onChange, destination }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dn-events", children: KINDS.map((kind) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "checkbox", checked: value[kind], "aria-label": `${destination}: ${LABELS[kind]}`, onChange: (e) => onChange({ ...value, [kind]: e.target.checked }) }),
    LABELS[kind]
  ] }, kind)) });
}
function SettingsSection({ runtime }) {
  const [view, setView] = (0, import_react.useState)();
  const [settings, setSettings] = (0, import_react.useState)();
  const [webhook, setWebhook] = (0, import_react.useState)("");
  const [removeWebhook, setRemoveWebhook] = (0, import_react.useState)(false);
  const [history2, setHistory] = (0, import_react.useState)([]);
  const [message, setMessage] = (0, import_react.useState)("");
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [permission, setPermission] = (0, import_react.useState)(permissionStatus);
  const connection = (0, import_react.useSyncExternalStore)(runtime.subscribe, runtime.snapshot);
  const reload = async () => {
    const next = await request("/settings");
    setView(next);
    const { revision: _revision, webhookConfigured: _configured, ...current } = next;
    setSettings({ ...current, baseUrl: current.baseUrl || window.location.origin });
    setWebhook("");
    setRemoveWebhook(false);
  };
  (0, import_react.useEffect)(() => {
    let alive = true;
    void reload().catch((e) => {
      if (alive) setMessage(e.message);
    });
    const poll = () => request("/history").then((rows) => {
      if (alive) setHistory(rows);
    }).catch(() => {
    });
    void poll();
    const timer = setInterval(poll, 5e3);
    const focus = () => setPermission(permissionStatus());
    window.addEventListener("focus", focus);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, []);
  const action = async (fn) => {
    setBusy(true);
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (!settings || !view) return;
    const next = await request("/settings", "PUT", {
      revision: view.revision,
      settings,
      ...removeWebhook ? { webhook: null } : webhook.trim() ? { webhook: webhook.trim() } : {}
    });
    setView(next);
    setWebhook("");
    setRemoveWebhook(false);
    setMessage("Settings saved.");
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "dn", "aria-label": "DSH Notify settings", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dn-heading", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { children: "DSH Notify" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dn-muted", children: "Choose when to receive browser and Slack notifications." })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { role: "status", className: "dn-message", children: message }),
    !settings || !view ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { onClick: () => void action(reload), children: "Reload settings" }) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("fieldset", { disabled: busy, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("legend", { children: "Browser" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dn-row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "checkbox", checked: settings.browser.enabled, onChange: (e) => setSettings({ ...settings, browser: { ...settings.browser, enabled: e.target.checked } }) }),
            "Browser notifications"
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dn-muted", children: permission })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { className: "dn-muted", children: [
          "Appears on this computer while a DSH tab is open. ",
          connection,
          "."
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dn-actions", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: !("Notification" in window) || !window.isSecureContext, onClick: () => {
            if ("Notification" in window) void Notification.requestPermission().then(() => {
              setPermission(permissionStatus());
              runtime.refresh();
            }).catch(() => setMessage("The browser could not request notification permission."));
          }, children: "Enable notifications" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", onClick: () => void action(async () => {
            runtime.test();
            setMessage("Test notification sent to this browser.");
          }), children: "Send test notification" })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(EventChoices, { destination: "Browser", value: settings.browser.events, onChange: (events) => setSettings({ ...settings, browser: { ...settings.browser, events } }) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("fieldset", { disabled: busy, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("legend", { children: "Slack" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dn-row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "checkbox", checked: settings.slack.enabled, onChange: (e) => setSettings({ ...settings, slack: { ...settings.slack, enabled: e.target.checked } }) }),
            "Slack notifications"
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dn-muted", children: removeWebhook ? "Will be removed on save" : view.webhookConfigured ? "Webhook configured" : "No webhook configured" })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "dn-field", children: [
          view.webhookConfigured ? "Replace webhook" : "Incoming webhook URL",
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "password", autoComplete: "off", spellCheck: false, placeholder: "https://hooks.slack.com/services/\u2026", value: webhook, onChange: (e) => {
            setWebhook(e.target.value);
            setRemoveWebhook(false);
          } })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dn-muted", children: "Stored privately on the DSH host. The saved URL is never returned to your browser." }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dn-actions", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: !view.webhookConfigured, onClick: () => {
            setRemoveWebhook(!removeWebhook);
            setWebhook("");
          }, children: removeWebhook ? "Keep webhook" : "Remove webhook" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: !view.webhookConfigured || !!webhook || removeWebhook, onClick: () => void action(async () => {
            await request("/test-slack", "POST");
            setMessage("Slack accepted the test notification.");
          }), children: "Send Slack test" })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(EventChoices, { destination: "Slack", value: settings.slack.events, onChange: (events) => setSettings({ ...settings, slack: { ...settings.slack, events } }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "checkbox", checked: settings.slack.includeSummary, onChange: (e) => setSettings({ ...settings, slack: { ...settings.slack, includeSummary: e.target.checked } }) }),
          "Include response summaries in Slack"
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dn-muted", children: "Off by default. Summaries may contain code or sensitive task details." })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("fieldset", { disabled: busy, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("legend", { children: "General" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "dn-field", children: [
          "DSH base URL",
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "url", value: settings.baseUrl, placeholder: window.location.origin, onChange: (e) => setSettings({ ...settings, baseUrl: e.target.value }) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dn-muted", children: "Used by \u201COpen in DSH\u201D in Slack. Defaults to this browser\u2019s origin when you save." }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "checkbox", checked: settings.notifySubagents, onChange: (e) => setSettings({ ...settings, notifySubagents: e.target.checked }) }),
          "Notify for subagents"
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dn-actions", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "dn-primary", disabled: busy, onClick: () => void action(save), children: busy ? "Working\u2026" : "Save settings" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { disabled: busy, onClick: () => void action(reload), children: "Reload saved settings" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("h3", { children: [
        "Recent deliveries ",
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dn-muted", children: "Last 20" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dn-muted", children: "Browser \u201Cdelivered\u201D means a browser accepted the notification. Your operating system may still silence it." }),
      !history2.length ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dn-empty", children: "No notifications yet. Your next task event will appear here." }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dn-table", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("table", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tr", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { children: "Event" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { children: "Time" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { children: "Browser" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { children: "Slack" })
        ] }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("tbody", { children: history2.map((h) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tr", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("td", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: LABELS[h.notice.kind] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dn-muted", children: h.notice.title }),
            h.error && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dn-error", children: h.error })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { children: new Date(h.notice.time).toLocaleTimeString() }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { children: h.browser }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("td", { children: [
            h.slack,
            h.attempts > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dn-muted", children: [
              h.attempts,
              " attempt",
              h.attempts === 1 ? "" : "s"
            ] }),
            h.nextAttempt && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dn-muted", children: [
              "Retry ",
              new Date(h.nextAttempt).toLocaleTimeString()
            ] })
          ] })
        ] }, h.seq)) })
      ] }) })
    ] })
  ] });
}

// src/client/styles.ts
var styles = `
.dn{width:100%;max-width:760px;min-width:0;font-family:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary,inherit)}
.dn *{box-sizing:border-box}
.dn h2{margin:0;font-size:18px;font-weight:600;line-height:1.5}
.dn h3{margin:24px 0 8px;font-size:15px;font-weight:600;line-height:22px}
.dn p{margin:6px 0 12px}
.dn-heading{margin-bottom:20px}
.dn-heading p{margin:8px 0 0;font-size:13px}
.dn fieldset{min-width:0;margin:0 0 20px;padding:0 0 20px;border:0;border-bottom:.5px solid var(--dsw-alias-border-l2,#8884)}
.dn legend{width:100%;margin:0 0 12px;padding:0;font-size:15px;font-weight:600;line-height:22px}
.dn label{display:flex;gap:8px;align-items:center;min-width:0}
.dn input[type=checkbox]{accent-color:var(--dsw-alias-brand-primary,#4d6bfe);width:16px;height:16px;margin:0;flex-shrink:0;cursor:pointer}
.dn-row{display:flex;align-items:center;justify-content:space-between;gap:8px 16px;flex-wrap:wrap;font-size:14px;line-height:22px}
.dn-muted{color:var(--dsw-alias-label-tertiary,#888);font-size:12px;font-weight:400}
.dn-field{align-items:stretch!important;flex-direction:column;gap:6px!important;margin:12px 0 6px;font-weight:500}
.dn input[type=url],.dn input[type=password]{width:100%;min-width:0;height:34px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4,#8885);border-radius:8px;font:inherit;font-weight:400;background:var(--dsw-alias-bg-layer-3,transparent);color:var(--dsw-alias-label-primary,inherit)}
.dn input::placeholder{color:var(--dsw-alias-label-tertiary,#888)}
.dn-actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}
.dn button{min-height:32px;border:.5px solid var(--dsw-alias-border-l4,#8885);border-radius:8px;padding:5px 12px;background:var(--dsw-alias-bg-layer-3,transparent);color:var(--dsw-alias-label-primary,inherit);font:inherit;font-weight:500;cursor:pointer}
.dn button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#8882)}
.dn button:disabled{opacity:.4;cursor:default}
.dn .dn-primary{background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff;border-color:transparent}
.dn .dn-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary,#4d6bfe);filter:brightness(.92)}
.dn :focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:2px}
.dn-events{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 20px;margin:16px 0 0}
.dn-events + label{margin-top:20px}
.dn-message:empty{display:none}
.dn-message{padding:10px 12px;background:var(--dsw-alias-bg-layer-3,#8881);border-radius:8px;margin:0 0 16px}
.dn-error{color:var(--dsw-alias-state-error-primary,#dc6b54);font-size:12px}
.dn-empty{color:var(--dsw-alias-label-tertiary,#888);font-size:13px}
.dn-table{overflow-x:auto}
.dn table{width:100%;border-collapse:collapse;font-size:12px;text-align:left}
.dn th{font-weight:500;color:var(--dsw-alias-label-tertiary,#888)}
.dn th,.dn td{padding:10px 8px;border-bottom:.5px solid var(--dsw-alias-border-l2,#8884);vertical-align:top}
.dn th:first-child,.dn td:first-child{padding-left:0}
.dn td:first-child{max-width:290px;overflow-wrap:anywhere}
.dn td strong{font-weight:500}
@media(max-width:560px){.dn-events{grid-template-columns:1fr}.dn-row{align-items:flex-start}.dn-actions button{max-width:100%}}
`;

// src/client/index.tsx
var inject = ["slots", "uiWorkspace"];
function apply(ctx) {
  const open = (id) => ctx.uiWorkspace.openSession(id);
  ctx.effect(() => {
    const runtime = new BrowserRuntime(open);
    runtime.start();
    const style = document.createElement("style");
    style.textContent = styles;
    document.head.appendChild(style);
    const unregister = ctx.slots.inject("settings.section", () => ctx.slots.register({
      name: "settings.section",
      id: "dsh-notify",
      order: 35,
      label: "DSH Notify",
      inject: () => ({ runtime })
    }, SettingsSection));
    const url = new URL(window.location.href), id = url.searchParams.get("dsh-notify-session");
    if (id) {
      open(id);
      url.searchParams.delete("dsh-notify-session");
      history.replaceState(history.state, "", url);
    }
    return () => {
      unregister();
      runtime.dispose();
      style.remove();
    };
  }, "dsh-notify: browser");
}
return module.exports; } });
