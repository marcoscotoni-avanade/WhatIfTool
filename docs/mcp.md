# Planner MCP server

The local MCP server exposes bounded project, activity, scenario, schedule, risk, change-preview, approval-request, operation-status, and JSON-export tools over stdio. It connects only to the planner HTTP service; it has no direct database, source-code, or arbitrary-path tools.

## Run locally

Start the local service in one terminal:

```sh
npm run service
```

Then start the stdio MCP server in another terminal:

```sh
npm run mcp
```

The VS Code MCP entry in `.vscode/mcp.json` launches the same MCP process from the workspace. It does not launch the service; start `npm run service` first.

By default the adapter connects to `http://127.0.0.1:1430`. The service URL must be `http://127.0.0.1:<port>` (`localhost` is normalized to `127.0.0.1`); HTTPS, IPv6, remote hosts, paths, query strings, and embedded credentials are rejected before any token is sent. The service creates its private connection file at `~/.whatiftool/connection.json`. It contains `url`, `agentToken`, and `uiToken`; the MCP adapter uses only `url` and `agentToken`, never `uiToken`. Keep this file private and protect it with user-only filesystem permissions. Alternatively, set `PLANNER_SERVICE_URL` and `PLANNER_AGENT_TOKEN`, or set `PLANNER_CONNECTION_FILE` to another private JSON file with those fields.

The service authenticates MCP requests with the agent bearer token. The desktop UI uses its separate UI token and handles approval-required publish, delete, and other sensitive operations. The MCP server can request these operations and read their status, but it does not expose an approval tool.

## Desktop UI connection

The desktop UI starts in standalone mode. Use **Connect service** in the application header to connect it to the loopback service with its URL (default `http://127.0.0.1:1430`) and the UI token; the UI token is kept in memory and is never read by this MCP adapter. On initial connect, New, or Open, the UI registers a project with the service. When opening an existing project ID, the service copy is authoritative and the UI warns if its content differs from the local copy.

While connected, the UI polls every two seconds. Network failures and revision conflicts block connected edits until the user refreshes or recovers; a response lost after a write is not replayed automatically, so refresh before retrying. Approval prompts remain in the UI and show the requested action, arguments, scenario, revision, and expiry. Saving checkpoints the authoritative service snapshot. Disconnecting returns to standalone mode with a new local history.

Connected CSV imports use the UI-only `replaceDocument` compare-and-swap flow; arbitrary callback candidates are not applied locally. Graph layout and drag changes use the bounded activity-patch command.

## Tool behavior

All tools validate inputs with Zod and return structured data. Project and scenario IDs are supplied explicitly; scenario-aware tools take `scenarioId`, where `null` explicitly selects the base project rather than an active UI scenario. Mutations require the service revision as `expectedRevision` and a caller-supplied unique `operationId`; there are no automatic retries or generated revisions. A stale revision or other HTTP error is returned as an MCP tool error.

Activity and project listing are paginated by required `limit` and `offset` inputs (maximum page size 100). `export_project` is limited to 1 MiB per response. For `apply_changes`, activity records use `{id?, patch}`; omit `id` to create an activity and include `patch.code` and `patch.name`. Dependency records use `{id?, patch}`; omit `id` to create one and include `patch.predecessorId` and `patch.successorId`. Delete requests require explicit activity IDs plus an optional dependency ID, or an explicit scenario ID. For an approval-required result, pass `result.operation.id` to `get_operation_status`; this is distinct from the caller-supplied idempotency `operationId`.

This is a local service integration only. It does not deploy or claim a live remote/cloud service or Copilot Studio integration.

`request_manage_baseline` requests `delete`, `archive` or `restore` using an explicit baseline ID
and exact `confirmationName`. All three require UI approval. Deletion is rejected if editable
scenarios reference the baseline; archive preserves their references and the immutable snapshot.
Use **Manage Baselines** in the UI for interactive management. Changes are recorded in the
service audit; no agent tool can approve its own request.
