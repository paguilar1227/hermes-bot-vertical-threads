# Catalog submission

`hermes-bot-vertical-threads.yaml` is ready to add as
`plugin-catalog/hermes-bot-vertical-threads.yaml` in a pull request against
`NousResearch/hermes-agent`.

It pins the published `v0.1.0` implementation commit. The catalog files were added
after that implementation so the entry can name an already published, immutable
revision. No runtime code differs from the pinned package.

The submission should disclose:

- This is a standalone Threads pane using public SDK APIs; it does not patch,
  replace, or read the markup of Bot Mode.
- Bot conversations open through Hermes's native session UI. Team conversations
  use `groups.*` with explicit connection/profile routing and existing approvals.
- The plugin reads connected conversation metadata and writes only its own local
  UI preferences/drafts, plus conversations/messages explicitly created by the user.
- It registers no model tools, Python code, shell commands, credentials, telemetry,
  third-party endpoints, or self-updater.
- Local validation: TypeScript, 27 tests, both browser suites, Docker build, and
  the official Hermes plugin validator passed. Browser integration uses a public-SDK
  test host with sample data, not a live installed Hermes or model endpoint.
- Public-SDK limitations and supported team types are described in the release README.

Listing requires a human maintainer to review and merge that upstream pull request.
This prepared file does not mean the plugin has been submitted or accepted.
