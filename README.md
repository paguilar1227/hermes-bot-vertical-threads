# Hermes Bot Vertical Threads

A standalone Hermes Desktop plugin for organizing conversations vertically under
bots and teams. It adds a **Threads** tab beside the existing sidebar tabs and
uses the public Desktop Plugin SDK. No Hermes patches or DOM modifications.

## Install

In Hermes Desktop, open **Capabilities → Plugins → Install from Git**, enter
`https://github.com/paguilar1227/hermes-bot-vertical-threads`, choose the Desktop
component, then enable **Vertical Threads**. The repository includes the ready-to-load
`desktop/plugin.js`; users do not need Node.js or a build step.

The equivalent CLI package install is:

```sh
hermes plugins install https://github.com/paguilar1227/hermes-bot-vertical-threads --ref v0.1.0
```

Enable the desktop component in Hermes after installation. This project is prepared
for catalog submission; it is **not yet approved or listed** in the Hermes marketplace.
Until approval, install from the repository URL rather than the catalog name.

## Use

- Open **Threads**, expand a bot or team, and select a conversation.
- Select **+ New thread** to start another conversation with that bot or team.
- Select `···` beside a thread to rename it. **Enter saves** the trimmed name.
  **Clicking outside or pressing Escape cancels** without saving.
- Drag a thread's grip to rearrange it within the same bot/team. **Alt + Up/Down**
  on the grip provides a keyboard alternative.
- Choose **Recent activity** for newest conversation activity first. Bot activity
  uses Hermes's `last_active`; team activity uses actual user/member message events.
  Rename, navigation, and dragging do not bump the activity time.
- Switch back to **Manual order** to restore your saved drag order. Manual dragging
  is disabled while automatic sorting is selected.

Names, manual order, sort mode, and expansion are stored in this plugin's namespaced
Hermes storage. Names are local display labels, not changes to the underlying
session title or room identity. They persist across reloads on that installation.
Thread identities include connection and profile so similarly named bots or teams
on different hosts stay separate.

## Compatibility and scope

The plugin targets the public SDK present in
[Hermes commit `0c298828`](https://github.com/NousResearch/hermes-agent/tree/0c298828c5b5cf9c03b41e35d92a282eaa8c2df7).
Older builds missing required SDK functions display an update message.

- **Bots:** lists stored, visible conversations for the selected bot/profile. The
  canonical **Bot Chat** remains available through Hermes's built-in Bots tab.
  Hermes's public persisted-session API returns at most 500 rows; the plugin
  displays a notice if a profile has more, rather than claiming the list is complete.
- **Teams:** lists gateway-backed rooms in each routed profile. Existing thread
  history is grouped by the backend's `thread_id`. New threads use that same team
  and member roster; they do not clone the team or create replacement bots.
  Legacy rooms stored only in the built-in frontend are not exposed by this SDK.
- **Team messaging:** supports text, existing message history, explicit approval
  choices, and task retry. Unknown action types direct you to Bot Mode. Attachments
  and the other Bot Mode management tools remain in Hermes's built-in interface.
- A failed or uncertain team send retains its exact event ID and payload for an
  explicit retry. It never silently submits another message on reload.

## Privacy and lifecycle

This is a desktop-only plugin. It does not register model tools, Python code,
background services, or its own network endpoints. It reads connected bot/profile
and conversation metadata through Hermes and routes user actions through Hermes's
existing authenticated APIs. It never reads credentials or changes authentication.

The visible pane refreshes using Bot Mode's five-second cadence. Team workspaces
refresh while mounted. Turning off the plugin removes its pane and closes its team
workspaces. Uninstall using Hermes's plugin manager. Conversation history remains
in Hermes; plugin-local preferences are retained by Hermes storage unless cleared
there. The plugin does not delete conversations or profiles.

## Development

Node.js 24 and npm, or Docker:

```sh
npm ci
npm run check
npm run test:browser
npm run test:plugin
# Or run typecheck, component tests, and build in Docker:
docker build -t hermes-bot-vertical-threads-check .
```

Browser scripts use installed Google Chrome by default. For Playwright's Chromium:

```sh
npx playwright install chromium
PLAYWRIGHT_CHANNEL=chromium npm run test:browser
PLAYWRIGHT_CHANNEL=chromium npm run test:plugin
```

`npm run build` emits the committed, readable `desktop/plugin.js`. React and the
SDK remain external and are supplied by Hermes; no second React runtime is bundled.
CI checks that the committed bundle matches its source.

Validation includes component and adapter tests, real-browser drag/drop and rename
checks, and loading the distributable into a public-SDK test host. The test host uses
sample data, so those checks do not claim a live model response or a full installed
Hermes end-to-end run. The package also passes Hermes's official plugin validator
(manifest, loadable entry, security scan, and public SDK surface).

## Marketplace submission

Hermes's catalog is human reviewed. A submission must pin an exact 40-character
commit SHA; listing requires a maintainer to merge the catalog entry. The plugin
has no self-updater. See the prepared entry under `catalog/` and
[the official catalog policy](https://github.com/NousResearch/hermes-agent/blob/0c298828c5b5cf9c03b41e35d92a282eaa8c2df7/plugin-catalog/README.md).
