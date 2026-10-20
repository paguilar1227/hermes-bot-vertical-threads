// src/plugin.tsx
import { host, useValue as useValue2 } from "@hermes/plugin-sdk";

// src/hermes-client.ts
var ownerKey = (kind, route, identity) => JSON.stringify([kind, route.connectionId, route.targetProfile, identity]);
function routeForAgent(agent, routes) {
  const route = routes.find((r) => r.connectionId === agent.connectionId && r.profile === agent.profile);
  if (!route) throw new Error(`No route for ${agent.handle}. Refresh the connections in Hermes.`);
  return { ...route };
}
function threadsFromEvents(events) {
  const threads = /* @__PURE__ */ new Map();
  for (const event of events) {
    const id = event.payload.thread_id;
    if (!id || !["message.user", "message.member"].includes(event.kind)) continue;
    const old = threads.get(id);
    const text = (event.payload.text || event.payload.content || "").trim();
    const at = Number.isFinite(event.created_at) ? event.created_at * 1e3 : 0;
    threads.set(id, {
      id,
      title: old?.title || text.split("\n")[0] || "Untitled thread",
      activityAt: Math.max(old?.activityAt || 0, at)
    });
  }
  return [...threads.values()];
}
var HermesClient = class {
  constructor(host2, storage) {
    this.host = host2;
    this.storage = storage;
  }
  host;
  storage;
  created = /* @__PURE__ */ new Map();
  disposed = false;
  dispose() {
    this.disposed = true;
  }
  assertActive() {
    if (this.disposed) throw new Error("Vertical Threads is disabled.");
  }
  async botThreads(route) {
    this.assertActive();
    const result = await this.host.listPersistedSessions(route, { profile: route.targetProfile, limit: 500 });
    const error = result.errors?.find((e) => e.profile === route.targetProfile);
    if (error) throw new Error(error.error);
    const key = ownerKey("bot", route, route.targetProfile);
    const sessions = {};
    for (const row of [...this.created.get(key) || [], ...result.sessions]) {
      sessions[row._lineage_root_id || row.id] = row;
    }
    return {
      sessions,
      total: result.total,
      truncated: result.total > result.sessions.length,
      threads: Object.entries(sessions).map(([id, row]) => ({
        id,
        title: row.title || "Untitled thread",
        activityAt: Number.isFinite(row.last_active) ? row.last_active * 1e3 : 0
      }))
    };
  }
  async createBotThread(route) {
    this.assertActive();
    const title = `Thread ${crypto.randomUUID()}`;
    const release = await this.host.retainProfile(route, { spawnPriority: "foreground" });
    try {
      const result = await this.request(route, "session.create", {
        title,
        hidden: false,
        follow_profile_config: true
      }, true);
      if (!result.session_id || !result.stored_session_id) throw new Error("Hermes did not return a stored conversation ID. Update Hermes Desktop.");
      await this.request(route, "session.title", { session_id: result.session_id, title }, true);
      this.assertActive();
      const row = { id: result.stored_session_id, title, last_active: 0 };
      const key = ownerKey("bot", route, route.targetProfile);
      this.created.set(key, [...this.created.get(key) || [], row]);
      return row;
    } finally {
      release();
    }
  }
  async openBotThread(route, session, title) {
    this.assertActive();
    return this.host.openSession(session.id, { route, profile: route.targetProfile, intent: "tab", tabTitle: title });
  }
  async teams(route) {
    const capabilities = await this.request(route, "groups.capabilities");
    if (!capabilities.driver) throw new Error("The Hermes team driver is unavailable on this connection. Start its gateway and refresh.");
    const rooms = [];
    let offset = 0;
    for (; ; ) {
      const page = await this.request(route, "groups.list", { offset });
      rooms.push(...page.rooms);
      if (page.next_offset === null) break;
      if (!Number.isSafeInteger(page.next_offset) || page.next_offset <= offset) throw new Error("Hermes returned an invalid team-list cursor.");
      offset = page.next_offset;
    }
    return rooms;
  }
  async room(route, roomId) {
    const snapshot = await this.request(route, "groups.state", { room_id: roomId });
    const events = [];
    let cursor = 0;
    for (; ; ) {
      const page = await this.request(route, "groups.log", { room_id: roomId, since_seq: cursor });
      events.push(...page.events);
      if (!page.has_more) break;
      if (!Number.isSafeInteger(page.cursor) || page.cursor <= cursor) throw new Error("Hermes returned an invalid team-history cursor.");
      cursor = page.cursor;
    }
    return { ...snapshot, events };
  }
  teamThreads(route, roomId, events) {
    const drafts = this.storage.get(this.draftKey(route, roomId), []);
    const threads = new Map(drafts.map((t) => [t.id, t]));
    for (const thread of threadsFromEvents(events)) threads.set(thread.id, thread);
    return [...threads.values()];
  }
  createTeamThread(route, roomId) {
    this.assertActive();
    const thread = { id: crypto.randomUUID(), title: "New thread", activityAt: 0 };
    const key = this.draftKey(route, roomId);
    this.storage.set(key, [...this.storage.get(key, []), thread]);
    return thread;
  }
  pending(route, roomId, threadId) {
    return this.storage.get(this.sendKey(route, roomId, threadId), null);
  }
  async send(route, roomId, threadId, text) {
    const key = this.sendKey(route, roomId, threadId);
    const pending = this.pending(route, roomId, threadId) ?? {
      event_id: crypto.randomUUID(),
      room_id: roomId,
      payload: { text: text.trim(), thread_id: threadId }
    };
    if (!pending.payload.text) throw new Error("Enter a message.");
    this.storage.set(key, pending);
    const result = await this.request(route, "groups.send", { ...pending }, true);
    if (result.accepted !== true) throw new Error("Hermes did not acknowledge this message. Retry to check the same send.");
    this.storage.set(key, null);
  }
  async resolveAction(route, roomId, action, choice) {
    if (!action.task_id || !action.member_id || !Number.isSafeInteger(action.execution_generation)) throw new Error("Invalid Hermes team action.");
    if (action.kind === "approval" && (!action.request_id || !choice)) throw new Error("Approval needs an explicit choice and request ID.");
    if (!["approval", "retry"].includes(action.kind)) throw new Error("Resolve this action in Hermes Bot Mode.");
    return this.request(route, action.kind === "approval" ? "groups.approve" : "groups.retry", {
      room_id: roomId,
      task_id: action.task_id,
      member_id: action.member_id,
      execution_generation: action.execution_generation,
      ...action.kind === "approval" ? { request_id: action.request_id, choice } : {}
    }, true);
  }
  request(route, method, params = {}, interactive = false) {
    this.assertActive();
    return this.host.requestProfile(
      route,
      method,
      { ...params, profile: route.targetProfile },
      void 0,
      interactive ? { spawnPriority: "foreground" } : void 0
    );
  }
  draftKey(route, roomId) {
    return `drafts.${ownerKey("team", route, roomId)}`;
  }
  sendKey(route, roomId, threadId) {
    return `send.${ownerKey("team", route, roomId)}.${threadId}`;
  }
};

// src/hermes-types.ts
var PLUGIN_ID = "hermes-bot-vertical-threads";
var LIVE_REFRESH_MS = 5e3;

// src/preferences.ts
var initial = () => ({ order: [], names: {}, sort: "manual", expanded: true });
var ThreadPreferences = class {
  constructor(storage) {
    this.storage = storage;
  }
  storage;
  records = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Map();
  get = (ownerId) => {
    let value = this.records.get(ownerId);
    if (!value) {
      const saved = this.storage.get(this.key(ownerId), null);
      value = {
        ...initial(),
        order: Array.isArray(saved?.order) ? saved.order.filter((id) => typeof id === "string") : [],
        names: saved?.names && typeof saved.names === "object" ? Object.fromEntries(Object.entries(saved.names).filter(([, name]) => typeof name === "string")) : {},
        sort: saved?.sort === "activity" ? "activity" : "manual",
        expanded: saved?.expanded !== false
      };
      this.records.set(ownerId, value);
    }
    return value;
  };
  subscribe = (ownerId, listener) => {
    const listeners = this.listeners.get(ownerId) ?? /* @__PURE__ */ new Set();
    listeners.add(listener);
    this.listeners.set(ownerId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(ownerId);
    };
  };
  update(ownerId, change) {
    const next = { ...this.get(ownerId), ...change };
    this.storage.set(this.key(ownerId), next);
    this.records.set(ownerId, next);
    this.listeners.get(ownerId)?.forEach((listener) => listener());
  }
  rename(ownerId, threadId, input) {
    const title = input.trim();
    if (!title) throw new Error("Enter a thread name.");
    this.update(ownerId, { names: { ...this.get(ownerId).names, [threadId]: title } });
  }
  move(ownerId, threads, from, target) {
    const ids = orderedThreads(threads, { ...this.get(ownerId), sort: "manual" }).map((t) => t.id);
    const fromIndex = ids.indexOf(from);
    const targetIndex = ids.indexOf(target);
    if (fromIndex < 0 || targetIndex < 0 || fromIndex === targetIndex) return;
    ids.splice(fromIndex, 1);
    ids.splice(targetIndex, 0, from);
    this.update(ownerId, { order: ids });
  }
  key(ownerId) {
    return `threads.v1.${encodeURIComponent(ownerId)}`;
  }
};
function orderedThreads(threads, preferences) {
  const rank = new Map(preferences.order.map((id, index) => [id, index]));
  const indexed = threads.map((thread, index) => ({ thread, index }));
  return indexed.sort((a, b) => {
    if (preferences.sort === "activity") {
      const delta = b.thread.activityAt - a.thread.activityAt;
      if (Number.isFinite(delta) && delta !== 0) return delta;
    }
    return (rank.get(a.thread.id) ?? preferences.order.length + a.index) - (rank.get(b.thread.id) ?? preferences.order.length + b.index);
  }).map(({ thread }) => thread);
}

// src/thread-pane.tsx
import { useQuery as useQuery2, useQueryClient as useQueryClient2, useValue } from "@hermes/plugin-sdk";
import { useState as useState3 } from "react";

// src/thread-list.tsx
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
var DRAG_TYPE = "application/x-hermes-vertical-thread";
function ThreadList({ owner, preferences }) {
  const prefs = useSyncExternalStore(
    (listener) => preferences.subscribe(owner.id, listener),
    () => preferences.get(owner.id)
  );
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(null);
  const rows = orderedThreads(owner.threads, prefs);
  const editingButton = useRef(null);
  const requestBusy = useRef(false);
  const run = async (action) => {
    if (requestBusy.current) return;
    requestBusy.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      requestBusy.current = false;
      setBusy(false);
    }
  };
  const title = (thread) => Object.hasOwn(prefs.names, thread.id) ? prefs.names[thread.id] : thread.title;
  const closeEditor = useCallback((restoreFocus) => {
    setEditing(null);
    if (restoreFocus) editingButton.current?.focus();
  }, []);
  return /* @__PURE__ */ jsxs("section", { className: "hvt", "aria-label": `${owner.title} threads`, children: [
    /* @__PURE__ */ jsxs("header", { className: "hvt-header", children: [
      /* @__PURE__ */ jsxs(
        "button",
        {
          type: "button",
          className: "hvt-toggle",
          "aria-expanded": prefs.expanded,
          onClick: () => void run(() => preferences.update(owner.id, { expanded: !prefs.expanded })),
          children: [
            /* @__PURE__ */ jsx("span", { "aria-hidden": "true", children: prefs.expanded ? "\u2304" : "\u203A" }),
            " Threads ",
            /* @__PURE__ */ jsx("span", { className: "hvt-count", children: rows.length })
          ]
        }
      ),
      prefs.expanded && /* @__PURE__ */ jsxs(
        "select",
        {
          className: "hvt-sort",
          "aria-label": `Sort ${owner.title} threads`,
          value: prefs.sort,
          onChange: (event) => void run(() => preferences.update(owner.id, { sort: event.target.value === "activity" ? "activity" : "manual" })),
          children: [
            /* @__PURE__ */ jsx("option", { value: "manual", children: "Manual order" }),
            /* @__PURE__ */ jsx("option", { value: "activity", children: "Recent activity" })
          ]
        }
      )
    ] }),
    prefs.expanded && /* @__PURE__ */ jsxs("div", { className: "hvt-branch", children: [
      /* @__PURE__ */ jsx("ul", { "aria-label": `${owner.title} thread list`, children: rows.map((thread, index) => /* @__PURE__ */ jsxs(
        "li",
        {
          className: `hvt-row${owner.activeThreadId === thread.id ? " is-active" : ""}${dragging === thread.id ? " is-dragging" : ""}`,
          onDragOver: (event) => {
            if (prefs.sort === "manual" && dragging && dragging !== thread.id) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
            }
          },
          onDrop: (event) => {
            event.preventDefault();
            if (prefs.sort !== "manual") return;
            try {
              const source = JSON.parse(event.dataTransfer.getData(DRAG_TYPE));
              if (source.ownerId === owner.id && typeof source.threadId === "string") {
                void run(() => preferences.move(owner.id, owner.threads, source.threadId, thread.id));
              }
            } catch {
            }
            setDragging(null);
          },
          children: [
            /* @__PURE__ */ jsx(
              "button",
              {
                type: "button",
                className: "hvt-grip",
                "aria-label": `Move ${title(thread)}`,
                disabled: prefs.sort !== "manual" || busy,
                title: prefs.sort === "manual" ? "Drag to reorder; Alt + \u2191 / \u2193 to move" : "Choose Manual order to rearrange",
                draggable: prefs.sort === "manual" && !busy,
                onDragStart: (event) => {
                  if (prefs.sort !== "manual") {
                    event.preventDefault();
                    return;
                  }
                  event.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ ownerId: owner.id, threadId: thread.id }));
                  event.dataTransfer.effectAllowed = "move";
                  setDragging(thread.id);
                },
                onDragEnd: () => setDragging(null),
                onKeyDown: (event) => {
                  if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
                  event.preventDefault();
                  const target = rows[index + (event.key === "ArrowUp" ? -1 : 1)];
                  if (target) void run(() => preferences.move(owner.id, owner.threads, thread.id, target.id));
                },
                children: "\u283F"
              }
            ),
            /* @__PURE__ */ jsx(
              "button",
              {
                type: "button",
                className: "hvt-name",
                "aria-current": owner.activeThreadId === thread.id ? "page" : void 0,
                title: title(thread),
                disabled: busy,
                onClick: () => void run(() => owner.openThread(thread.id)),
                children: title(thread)
              }
            ),
            /* @__PURE__ */ jsx(
              "button",
              {
                type: "button",
                className: "hvt-edit",
                "aria-label": `Rename ${title(thread)}`,
                title: "Rename thread",
                disabled: busy,
                onClick: (event) => {
                  editingButton.current = event.currentTarget;
                  setEditing(thread);
                },
                children: "\xB7\xB7\xB7"
              }
            )
          ]
        },
        thread.id
      )) }),
      /* @__PURE__ */ jsx("button", { type: "button", className: "hvt-new", disabled: busy, onClick: () => void run(() => owner.createThread()), children: "+ New thread" })
    ] }),
    error && /* @__PURE__ */ jsx("p", { className: "hvt-error", role: "alert", children: error }),
    editing && /* @__PURE__ */ jsx(RenameDialog, { title: title(editing), onCancel: closeEditor, onSave: (value) => {
      preferences.rename(owner.id, editing.id, value);
      closeEditor(true);
    } })
  ] });
}
function RenameDialog({ title, onCancel, onSave }) {
  const [draft, setDraft] = useState(title);
  const [error, setError] = useState("");
  const dialog = useRef(null);
  const input = useRef(null);
  const labelId = useId();
  const inputId = useId();
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
    const outside = (event) => {
      if (event.target instanceof Node && !dialog.current?.contains(event.target)) onCancel(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [onCancel]);
  return /* @__PURE__ */ jsx("div", { className: "hvt-backdrop", children: /* @__PURE__ */ jsxs(
    "div",
    {
      className: "hvt-dialog",
      ref: dialog,
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": labelId,
      onKeyDown: (event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onCancel(true);
        }
        if (event.key === "Tab") {
          event.preventDefault();
          input.current?.focus();
        }
      },
      children: [
        /* @__PURE__ */ jsx("label", { id: labelId, htmlFor: inputId, children: "Rename thread" }),
        /* @__PURE__ */ jsx(
          "input",
          {
            ref: input,
            id: inputId,
            value: draft,
            autoComplete: "off",
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
              event.preventDefault();
              event.stopPropagation();
              try {
                onSave(draft);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
            }
          }
        ),
        /* @__PURE__ */ jsx("p", { children: "Enter to save \xB7 Click outside or Esc to cancel" }),
        error && /* @__PURE__ */ jsx("p", { className: "hvt-error", role: "alert", children: error })
      ]
    }
  ) });
}

// src/team-chat.tsx
import { useQuery, useQueryClient } from "@hermes/plugin-sdk";
import { useId as useId2, useRef as useRef2, useState as useState2 } from "react";

// src/styles.ts
var pluginStyles = true ? ".hvt { color: var(--ui-text-primary, #e7eeed); font: inherit; font-size: 13px; min-width: 0; }\n.hvt button, .hvt select, .hvt input { font: inherit; color: inherit; }\n.hvt button { border: 0; background: transparent; cursor: pointer; }\n.hvt button:disabled { cursor: default; opacity: .45; }\n.hvt button:focus-visible, .hvt select:focus-visible, .hvt input:focus-visible { outline: 2px solid var(--ui-accent, #87c9bd); outline-offset: 2px; }\n.hvt-header { display: flex; align-items: center; justify-content: space-between; gap: 4px; padding: 2px 8px 4px 24px; }\n.hvt-toggle { display: flex; align-items: center; gap: 6px; color: var(--ui-text-tertiary, #b0bdbc) !important; padding: 4px 0; }\n.hvt-count { font-size: 11px; opacity: .7; }\n.hvt-sort { min-width: 0; max-width: 125px; padding: 3px; border: 0; border-radius: 4px; font-size: 11px !important; background: var(--ui-bg-secondary, #253137); }\n.hvt-branch { margin: 0 8px 12px 26px; padding: 0 0 0 8px; border-left: 1px solid var(--ui-stroke-secondary, #425454); }\n.hvt ul { list-style: none; margin: 0; padding: 0; }\n.hvt-row { display: flex; align-items: center; min-height: 36px; border-radius: 5px; }\n.hvt-row:hover { background: var(--ui-bg-hover, #2b3b3e); }\n.hvt-row.is-active { background: var(--ui-bg-selected, #30484c); }\n.hvt-row.is-dragging { opacity: .5; }\n.hvt-grip { flex: 0 0 22px; padding: 6px 2px; opacity: .55; cursor: grab !important; }\n.hvt-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; padding: 7px 3px; }\n.hvt-edit { flex: 0 0 30px; padding: 6px; font-weight: bold !important; }\n.hvt-new { padding: 8px 5px; color: var(--ui-text-secondary, #c3d0ce) !important; }\n.hvt-error { margin: 6px 8px; color: var(--ui-text-danger, #ffb4b4); font-size: 12px; }\n.hvt-backdrop { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; background: #0005; }\n.hvt-dialog { width: min(340px, calc(100vw - 32px)); box-sizing: border-box; padding: 20px; border: 1px solid var(--ui-stroke-secondary, #526260); border-radius: 10px; box-shadow: 0 12px 40px #0005; background: var(--ui-bg-primary, #202c31); }\n.hvt-dialog label { display: block; margin-bottom: 10px; font-weight: 600; }\n.hvt-dialog input { box-sizing: border-box; width: 100%; padding: 9px; border: 1px solid var(--ui-stroke-secondary, #526260); border-radius: 5px; background: var(--ui-bg-secondary, #29393b); }\n.hvt-dialog p { margin: 12px 0 0; font-size: 11px; color: var(--ui-text-secondary, #b8c8c4); }\n.hvt-pane { height: 100%; overflow: auto; padding: 8px; box-sizing: border-box; }\n.hvt-pane-heading { display: flex; align-items: center; justify-content: space-between; padding: 8px; }\n.hvt-pane h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--ui-text-tertiary, #b0bdbc); margin: 18px 8px 8px; }\n.hvt-pane p { font-size: 12px; margin: 8px; }\n.hvt-owner { display: flex; align-items: center; gap: 8px; width: 100%; padding: 12px 8px; text-align: left; border-radius: 5px; }\n.hvt-owner:hover { background: var(--ui-bg-hover, #2b3b3e); }\n.hvt-owner strong { overflow: hidden; text-overflow: ellipsis; }\n.hvt-owner small { margin-left: auto; font-size: 10px; color: var(--ui-text-secondary, #c3d0ce); }\n.hvt-chat { display: flex; flex-direction: column; height: 100%; box-sizing: border-box; padding: 18px; gap: 12px; }\n.hvt-chat header p { color: var(--ui-text-secondary, #c3d0ce); }\n.hvt-history { flex: 1; min-height: 0; overflow: auto; }\n.hvt-history article { margin-bottom: 12px; padding: 12px; border-radius: 6px; background: var(--ui-bg-secondary, #253137); }\n.hvt-history p { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.5; }\n.hvt-chat form { display: flex; flex-direction: column; gap: 8px; }\n.hvt-chat textarea { font: inherit; color: inherit; padding: 10px; min-height: 70px; border-radius: 5px; border: 1px solid var(--ui-stroke-secondary, #425454); background: var(--ui-bg-secondary, #253137); }\n.hvt-chat button, .hvt-action button { border: 1px solid var(--ui-stroke-secondary, #425454); padding: 8px 12px; border-radius: 5px; }\n.hvt-action pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 180px; overflow: auto; }\n" : "";

// src/team-chat.tsx
import { Fragment, jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";
var roomQueryKey = (route, roomId) => [PLUGIN_ID, "room", ownerKey("team", route, roomId)];
function ChatHistory({ events, loading }) {
  return /* @__PURE__ */ jsxs2("div", { className: "hvt-history", role: "log", "aria-label": "Team messages", children: [
    events.map((event) => /* @__PURE__ */ jsxs2("article", { children: [
      /* @__PURE__ */ jsx2("strong", { children: event.actor?.display_name || event.actor?.id || event.kind }),
      /* @__PURE__ */ jsx2("p", { children: event.payload.text || event.payload.content || event.payload.error || event.payload.reason || event.kind })
    ] }, event.seq)),
    !loading && !events.length && /* @__PURE__ */ jsx2("p", { children: "Start this thread with a message to the team." })
  ] });
}
function PendingActions({ actions, busy, resolve }) {
  return /* @__PURE__ */ jsx2(Fragment, { children: actions.map((action) => /* @__PURE__ */ jsxs2("div", { className: "hvt-action", children: [
    /* @__PURE__ */ jsxs2("strong", { children: [
      action.member_id,
      ": ",
      action.kind
    ] }),
    !action.thread_id && /* @__PURE__ */ jsx2("span", { children: "Team-wide action" }),
    /* @__PURE__ */ jsx2("pre", { children: JSON.stringify(action, null, 2) }),
    action.kind === "approval" ? /* @__PURE__ */ jsxs2(Fragment, { children: [
      /* @__PURE__ */ jsx2("button", { disabled: busy, onClick: () => resolve(action, "once"), children: "Allow once" }),
      /* @__PURE__ */ jsx2("button", { disabled: busy, onClick: () => resolve(action, "deny"), children: "Deny" })
    ] }) : action.kind === "retry" ? /* @__PURE__ */ jsx2("button", { disabled: busy, onClick: () => resolve(action), children: "Retry task" }) : /* @__PURE__ */ jsx2("p", { children: "Resolve this action in Hermes Bot Mode." })
  ] }, `${action.kind}/${action.task_id}/${action.execution_generation}`)) });
}
function TeamChat({ client, route, room, threadId, title }) {
  const cache = useQueryClient();
  const messageInputId = useId2();
  const query = useQuery({ queryKey: roomQueryKey(route, room.room_id), queryFn: () => client.room(route, room.room_id), refetchInterval: LIVE_REFRESH_MS, retry: false });
  const [draft, setDraft] = useState2(() => client.pending(route, room.room_id, threadId)?.payload.text || "");
  const [error, setError] = useState2("");
  const [busy, setBusy] = useState2(false);
  const busyRef = useRef2(false);
  const pending = client.pending(route, room.room_id, threadId);
  const events = query.data?.events.filter((event) => event.payload.thread_id === threadId) || [];
  const actions = query.data?.driver_status?.pending_actions?.filter((action) => !action.thread_id || action.thread_id === threadId) || [];
  const perform = async (action) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
      await cache.invalidateQueries({ queryKey: roomQueryKey(route, room.room_id) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return /* @__PURE__ */ jsxs2("section", { className: "hvt hvt-chat", "aria-label": `${room.name}: ${title}`, children: [
    /* @__PURE__ */ jsx2("style", { children: pluginStyles }),
    /* @__PURE__ */ jsxs2("header", { children: [
      /* @__PURE__ */ jsx2("strong", { children: title }),
      /* @__PURE__ */ jsxs2("p", { children: [
        room.name,
        " \xB7 ",
        room.members.map((member) => member.display_name || member.handle).join(", ")
      ] })
    ] }),
    query.isPending && /* @__PURE__ */ jsx2("p", { role: "status", children: "Loading thread\u2026" }),
    query.error && /* @__PURE__ */ jsxs2("p", { className: "hvt-error", role: "alert", children: [
      query.error.message,
      " ",
      /* @__PURE__ */ jsx2("button", { onClick: () => void query.refetch(), children: "Retry" })
    ] }),
    /* @__PURE__ */ jsx2(ChatHistory, { events, loading: query.isPending }),
    /* @__PURE__ */ jsx2(PendingActions, { actions, busy, resolve: (action, choice) => void perform(() => client.resolveAction(route, room.room_id, action, choice)) }),
    error && /* @__PURE__ */ jsx2("p", { role: "alert", className: "hvt-error", children: error }),
    pending && /* @__PURE__ */ jsx2("p", { role: "status", children: "The last send is unconfirmed. Retry checks the same message; it will not create a second send." }),
    query.data && !query.data.driver_status && /* @__PURE__ */ jsx2("p", { role: "status", children: "The team driver is unavailable. Reconnect its gateway to send messages." }),
    /* @__PURE__ */ jsxs2("form", { onSubmit: (event) => {
      event.preventDefault();
      void perform(async () => {
        await client.send(route, room.room_id, threadId, draft);
        setDraft("");
      });
    }, children: [
      /* @__PURE__ */ jsx2("label", { htmlFor: messageInputId, children: "Message the team" }),
      /* @__PURE__ */ jsx2("textarea", { id: messageInputId, value: draft, onChange: (event) => setDraft(event.target.value), disabled: busy || !!pending }),
      /* @__PURE__ */ jsx2("button", { type: "submit", disabled: busy || !query.data?.driver_status || !pending && !draft.trim(), children: pending ? "Retry send" : "Send" })
    ] })
  ] });
}

// src/thread-pane.tsx
import { Fragment as Fragment2, jsx as jsx3, jsxs as jsxs3 } from "react/jsx-runtime";
function ThreadPane({ client, preferences, visible, openTeam }) {
  const roster = useQuery2({
    queryKey: [PLUGIN_ID, "roster"],
    enabled: visible,
    retry: false,
    queryFn: async () => ({ ...await client.host.agents(), routes: await client.host.profileRoutes() }),
    refetchInterval: visible ? LIVE_REFRESH_MS : false
  });
  const routes = roster.data?.routes || [];
  const teamRoutes = [...new Map(routes.map((route) => [JSON.stringify([route.connectionId, route.targetProfile]), route])).values()];
  return /* @__PURE__ */ jsxs3("section", { className: "hvt hvt-pane", "aria-label": "Vertical Threads", children: [
    /* @__PURE__ */ jsx3("style", { children: pluginStyles }),
    /* @__PURE__ */ jsxs3("header", { className: "hvt-pane-heading", children: [
      /* @__PURE__ */ jsx3("strong", { children: "Threads" }),
      /* @__PURE__ */ jsx3("button", { disabled: roster.isFetching, onClick: () => void roster.refetch(), children: "Refresh" })
    ] }),
    roster.error && /* @__PURE__ */ jsx3("p", { role: "alert", className: "hvt-error", children: roster.error.message }),
    roster.isPending && /* @__PURE__ */ jsx3("p", { role: "status", children: "Loading bots and teams\u2026" }),
    roster.data?.sources.filter((source) => source.error).map((source) => /* @__PURE__ */ jsxs3("p", { className: "hvt-error", role: "status", children: [
      source.label,
      ": ",
      source.error
    ] }, source.connectionId)),
    /* @__PURE__ */ jsx3("h2", { children: "Bots" }),
    roster.data?.agents.map((agent) => {
      const route = routes.find((r) => r.connectionId === agent.connectionId && r.profile === agent.profile);
      return route ? /* @__PURE__ */ jsx3(BotThreads, { client, preferences, agent, route: routeForAgent(agent, routes), visible }, ownerKey("bot", route, route.targetProfile)) : /* @__PURE__ */ jsxs3("p", { role: "status", children: [
        agent.handle,
        ": connection unavailable"
      ] }, `${agent.connectionId}/${agent.profile}`);
    }),
    roster.data && !roster.data.agents.length && /* @__PURE__ */ jsx3("p", { children: "No bots found. Add a profile or connection in Hermes." }),
    /* @__PURE__ */ jsx3("h2", { children: "Teams" }),
    teamRoutes.map((route) => /* @__PURE__ */ jsx3(
      ConnectionTeams,
      {
        client,
        preferences,
        route,
        visible,
        openTeam,
        label: `${roster.data?.sources.find((s) => s.connectionId === route.connectionId)?.label || roster.data?.agents.find((a) => a.connectionId === route.connectionId)?.connectionLabel || route.connectionId} \xB7 ${route.targetProfile}`
      },
      ownerKey("team", route, "rooms")
    ))
  ] });
}
function BotThreads({ client, preferences, agent, route, visible }) {
  const [expanded, setExpanded] = useState3(false);
  const focused = useValue(client.host.state.focusedStoredSessionId);
  const cache = useQueryClient2();
  const ownerId = ownerKey("bot", route, route.targetProfile);
  const key = [PLUGIN_ID, "bot", ownerId];
  const result = useQuery2({ queryKey: key, queryFn: () => client.botThreads(route), enabled: visible && expanded, refetchInterval: visible && expanded ? LIVE_REFRESH_MS : false, retry: false });
  const title = agent.profileMetadata?.ui_meta?.["hermes-bots"]?.title || agent.profileMetadata?.display_name || agent.profile;
  return /* @__PURE__ */ jsxs3("article", { children: [
    /* @__PURE__ */ jsxs3("button", { className: "hvt-owner", "aria-expanded": expanded, onClick: () => setExpanded((value) => !value), children: [
      /* @__PURE__ */ jsx3("span", { "aria-hidden": "true", children: expanded ? "\u2304" : "\u203A" }),
      /* @__PURE__ */ jsx3("strong", { children: title }),
      /* @__PURE__ */ jsx3("small", { children: agent.connectionLabel })
    ] }),
    expanded && /* @__PURE__ */ jsxs3(Fragment2, { children: [
      result.isPending && /* @__PURE__ */ jsx3("p", { role: "status", children: "Loading threads\u2026" }),
      result.error && /* @__PURE__ */ jsxs3("p", { role: "alert", className: "hvt-error", children: [
        result.error.message,
        " ",
        /* @__PURE__ */ jsx3("button", { onClick: () => void result.refetch(), children: "Retry" })
      ] }),
      result.data && /* @__PURE__ */ jsx3(ThreadList, { preferences, owner: {
        id: ownerId,
        title,
        kind: "bot",
        threads: result.data.threads,
        activeThreadId: result.data.threads.find((thread) => result.data.sessions[thread.id]?.id === focused)?.id,
        openThread: async (id) => {
          const session = result.data.sessions[id];
          if (!session) throw new Error("This conversation is no longer available. Refresh the list.");
          await client.openBotThread(route, session, preferences.get(ownerId).names[id] || session.title || "Thread");
        },
        createThread: async () => {
          const session = await client.createBotThread(route);
          preferences.rename(ownerId, session.id, "New thread");
          await cache.invalidateQueries({ queryKey: key });
          await client.openBotThread(route, session, "New thread");
        }
      } }, ownerId),
      result.data?.truncated && /* @__PURE__ */ jsxs3("p", { role: "status", children: [
        "Showing ",
        result.data.threads.length,
        " of ",
        result.data.total,
        " conversations. This Hermes SDK limits this list to 500. The main Bot Chat stays in Bot Mode."
      ] })
    ] })
  ] });
}
function ConnectionTeams({ client, preferences, route, visible, openTeam, label }) {
  const rooms = useQuery2({ queryKey: [PLUGIN_ID, "teams", ownerKey("team", route, "rooms")], queryFn: () => client.teams(route), enabled: visible, refetchInterval: visible ? LIVE_REFRESH_MS : false, retry: false });
  if (rooms.error) return /* @__PURE__ */ jsxs3("p", { className: "hvt-error", role: "status", children: [
    label,
    ": ",
    rooms.error.message,
    " ",
    /* @__PURE__ */ jsx3("button", { onClick: () => void rooms.refetch(), children: "Retry" })
  ] });
  if (rooms.isPending) return /* @__PURE__ */ jsx3("p", { role: "status", children: "Loading teams\u2026" });
  return /* @__PURE__ */ jsxs3(Fragment2, { children: [
    rooms.data?.map((room) => /* @__PURE__ */ jsx3(TeamThreads, { client, preferences, route, room, visible, openTeam, label }, ownerKey("team", route, room.room_id))),
    !rooms.data?.length && /* @__PURE__ */ jsx3("p", { children: "No gateway-backed teams on this connection. Create one in Hermes Bot Mode." })
  ] });
}
function TeamThreads({ client, preferences, route, room, visible, openTeam, label }) {
  const [expanded, setExpanded] = useState3(false);
  const [active, setActive] = useState3(null);
  const [revision, setRevision] = useState3(0);
  const ownerId = ownerKey("team", route, room.room_id);
  const result = useQuery2({ queryKey: roomQueryKey(route, room.room_id), queryFn: () => client.room(route, room.room_id), enabled: visible && expanded, refetchInterval: visible && expanded ? LIVE_REFRESH_MS : false, retry: false });
  void revision;
  const threads = client.teamThreads(route, room.room_id, result.data?.events || []);
  const open = (id) => {
    const thread = threads.find((t) => t.id === id);
    if (!thread) throw new Error("This thread is unavailable. Refresh the team.");
    openTeam(route, room, id, preferences.get(ownerId).names[id] || thread.title);
    setActive(id);
  };
  return /* @__PURE__ */ jsxs3("article", { children: [
    /* @__PURE__ */ jsxs3("button", { className: "hvt-owner", "aria-expanded": expanded, onClick: () => setExpanded((value) => !value), children: [
      /* @__PURE__ */ jsx3("span", { "aria-hidden": "true", children: expanded ? "\u2304" : "\u203A" }),
      /* @__PURE__ */ jsx3("strong", { children: room.name }),
      /* @__PURE__ */ jsxs3("small", { children: [
        label,
        " \xB7 ",
        room.members.length,
        " members"
      ] })
    ] }),
    expanded && /* @__PURE__ */ jsxs3(Fragment2, { children: [
      result.error && /* @__PURE__ */ jsxs3("p", { role: "alert", className: "hvt-error", children: [
        result.error.message,
        " ",
        /* @__PURE__ */ jsx3("button", { onClick: () => void result.refetch(), children: "Retry" })
      ] }),
      result.isPending ? /* @__PURE__ */ jsx3("p", { role: "status", children: "Loading threads\u2026" }) : /* @__PURE__ */ jsx3(ThreadList, { preferences, owner: {
        id: ownerId,
        title: room.name,
        kind: "team",
        threads,
        activeThreadId: active,
        openThread: open,
        createThread: () => {
          const thread = client.createTeamThread(route, room.room_id);
          setRevision((value) => value + 1);
          openTeam(route, room, thread.id, thread.title);
          setActive(thread.id);
        }
      } }, ownerId)
    ] })
  ] });
}
function openTeamWorkspace(client, panes, route, room, threadId, title) {
  client.assertActive();
  const key = `${PLUGIN_ID}:${ownerKey("team", route, room.room_id)}:${threadId}`;
  const close = client.host.openWorkspace(key, {
    title: `${room.name} \xB7 ${title}`,
    onClose: () => panes.delete(key),
    render: () => /* @__PURE__ */ jsx3(TeamChat, { client, route, room, threadId, title }, key)
  });
  panes.set(key, close);
}

// src/plugin.tsx
import { jsx as jsx4 } from "react/jsx-runtime";
var plugin_default = {
  id: PLUGIN_ID,
  name: "Vertical Threads",
  description: "Organize bot and team conversations vertically, with names, manual order and activity sorting.",
  defaultEnabled: false,
  register(ctx) {
    const client = new HermesClient(host, ctx.storage);
    const preferences = new ThreadPreferences(ctx.storage);
    const panes = /* @__PURE__ */ new Map();
    const supported = ["agents", "profileRoutes", "requestProfile", "retainProfile", "listPersistedSessions", "openSession", "openWorkspace", "paneVisibility"].every((key) => typeof host[key] === "function");
    function Pane() {
      const visible = useValue2(host.paneVisibility(`${PLUGIN_ID}:pane`));
      return /* @__PURE__ */ jsx4(ThreadPane, { client, preferences, visible, openTeam: (...args) => openTeamWorkspace(client, panes, ...args) });
    }
    ctx.register({
      id: "pane",
      area: "panes",
      title: "Threads",
      data: { placement: "left", width: "300px", collapsible: true, hideOnly: true, dock: { pane: "sessions", pos: "center" } },
      render: () => supported ? /* @__PURE__ */ jsx4(Pane, {}) : /* @__PURE__ */ jsx4("p", { children: "Update Hermes Desktop to use Vertical Threads. This build is missing a required public SDK capability." })
    });
    ctx.onDispose(() => {
      client.dispose();
      for (const close of [...panes.values()]) close();
      panes.clear();
    });
  }
};
export {
  plugin_default as default
};
