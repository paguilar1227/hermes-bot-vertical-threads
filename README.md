# Hermes Bot Vertical Threads

Vertical thread controls for Hermes Desktop's bots and teams: editable names,
drag-and-drop ordering, and sorting by recent conversation activity.

**Status: UI implementation; Hermes integration pending.** This repository does
not yet contain an installable Hermes plugin. The controls work against a typed
host interface and have automated browser coverage, but they have not been
connected to real Hermes conversations.

## Behavior

- Threads appear as indented rows under their bot or team.
- The `···` button opens the rename dialog. **Enter** saves the trimmed name.
  Clicking outside or pressing **Escape** discards the draft. An empty name
  remains in the dialog with an error. IME composition Enter does not save.
- Drag the grip to reorder within one bot/team. **Alt + Up/Down** on the grip
  provides a keyboard alternative.
- Choose **Recent activity** to sort by the most recent conversation activity.
  Navigation, rename, and reordering do not change the activity timestamp.
- Choose **Manual order** to restore the saved drag order. Dragging is disabled
  while automatic sorting is selected.
- Names, sort mode, order, and expansion persist in host-provided storage, scoped
  by the connection-qualified owner identity.

Names are currently presentation labels owned by this component. They do not
rename server sessions until the final Hermes adapter defines that behavior.
Creating/opening a thread delegates to the host and reports failures in the list.

## Integration decision

Hermes Desktop's public SDK currently offers session-row decoration slots and
layout panes. Its bundled Bot Mode constructs bot and team rows directly and
does not expose a child-thread slot. Checked against
[`NousResearch/hermes-agent` at `0c298828`](https://github.com/NousResearch/hermes-agent/tree/0c298828c5b5cf9c03b41e35d92a282eaa8c2df7).

Two possible integration paths are under consideration:

1. A small compatibility extension in Hermes, with this plugin rendering below
   existing bot/team rows. This matches the requested layout most closely.
2. A standalone Threads pane using public SDK capabilities, without changing
   Hermes. This would be a separate surface rather than modifying existing rows.

Neither path is silently installed or applied by this repository. No Hermes
files, profiles, conversations, or settings have been changed.

Integration references:

- [Public SDK](https://github.com/NousResearch/hermes-agent/blob/0c298828c5b5cf9c03b41e35d92a282eaa8c2df7/apps/desktop/src/sdk/index.ts)
- [Bot/team row construction](https://github.com/NousResearch/hermes-agent/blob/0c298828c5b5cf9c03b41e35d92a282eaa8c2df7/apps/desktop/src/plugins/hermes-bots/roster-pane.tsx)
- [Runtime plugin guide](https://github.com/NousResearch/hermes-agent/blob/0c298828c5b5cf9c03b41e35d92a282eaa8c2df7/website/docs/developer-guide/desktop-plugin-sdk.md)

## Development and verification

Node.js 24 and npm:

```sh
npm ci
npm run check
```

`check` runs TypeScript, component tests, and the bundle build. Browser checks
exercise both bot and team lists in installed Google Chrome:

```sh
npm run test:browser
```

The browser fixture is explicitly sample data. It verifies UI behavior and
does not prove real Hermes navigation, message delivery, or live gateway updates.

The portable build/test environment is also available through Docker:

```sh
docker build -t hermes-bot-vertical-threads-check .
```

No background service is installed. To stop using the component, unmount it and
unsubscribe from its host adapter. Persisted preferences are retained by the
supplied storage; removing the package does not delete conversation data.
