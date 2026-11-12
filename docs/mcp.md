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

`list_activities` filters and pages on the service using a single project revision. Optional
filters are `text` (case-insensitive code, name or description), `ownerId` (null selects
unassigned activities), `type`, `status`, `tags: { values, match: "any" | "all" }`, and
`date: { field, from?, to? }` for planned or calculated start/finish. Bounds are inclusive;
date-only upper bounds include the whole UTC day. Missing dates do not match. Filters combine
with AND. `sort: { field, direction }` orders by an allowed field and breaks ties by ID;
the default order is ID. Calculated-date filters invoke the scheduling engine.

`rename_scenario` changes the name of an editable scenario with revision and operation ID
checks; published baselines remain immutable. `create_scenario` with `clone: true` creates
an inheriting child, not an independent copy: later parent changes propagate unless overridden.

`get_duration_proposal` returns the pending proposal ID, revision and individual calculations
without exposing its complete candidate document. `resolve_duration_proposal` accepts that ID
and chooses `apply_selected`, `keep_durations`, or `cancel`. Selected IDs must belong to the
proposal and have applicable calculated durations. Resolving a draft proposal requires UI
approval; stale revisions and obsolete proposal IDs are rejected.

`get_team`, `get_tag_catalog`, `list_calendars`, and `get_calendar` read metadata from the
requested scenario. `update_team`, `set_tag_catalog`, and `upsert_calendar` use revisioned
service commands. Removing team members or catalog tags requires UI approval even in scenarios;
an assigned member cannot be removed until activities are reassigned. Calendar and allocation
changes can create duration proposals. Calendar deletion is not exposed.

`list_dependencies` supports endpoint/type filters and bounded ancestor or descendant
traversal. `analyze_dependencies` adds calculated slack and critical flags for both ends;
it does not claim that critical activities form one unique path. `diagnose_plan` reports
paginated schedule violations, negative slack, date overruns and informational structural
issues. Diagnostics never automatically change the project or introduce a new risk formula.

`list_operation_history` returns a filtered, paginated, newest-first projection of the retained
audit, without command payloads. At most 1000 events per project are retained; older events
and failures that occurred before this functionality existed cannot be reconstructed. Actors
are `ui`, `agent`, or `system` for expiry, not identified individual users. Expiry is recorded
when approval status is checked or an expired request is decided.

`request_import_project` accepts a structured project JSON object, not a local path or URL.
The model is validated and limited to 2 MiB, 10,000 activities, 20,000 dependencies and
1,000 scenarios. The request returns an import ID and stays pending until a UI user opens
**Connect service → List import requests** and approves it. `get_import_status` reports its
status. An existing project ID is never overwritten; a collision at approval reports
`conflict`. A request expires after 15 minutes. Operation IDs are idempotent while retained;
the queue retains up to 100 active and 400 previous requests. Interrupted approvals are
recovered on service startup. Importing `.pgplan` and remote URLs is not supported.

This is a local service integration only. It does not deploy or claim a live remote/cloud service or Copilot Studio integration.

`request_manage_baseline` requests `delete`, `archive` or `restore` using an explicit baseline ID
and exact `confirmationName`. All three require UI approval. Deletion is rejected if editable
scenarios reference the baseline; archive preserves their references and the immutable snapshot.
Use **Manage Baselines** in the UI for interactive management. Changes are recorded in the
service audit; no agent tool can approve its own request.
