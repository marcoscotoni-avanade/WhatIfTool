# Project Risk Planner

A local-first **Project Schedule Digital Twin** for exploring dependencies, deterministic
scheduling, explainable Risk Exposure Scores and milestone mitigation priorities.

**Edit -> recalculate -> visualize impact -> explain risk -> compare scenarios.**

This is a graph-first analytical tool, not a Microsoft Project replacement. No authentication,
cloud resources, external database, backend service or telemetry is used. All application assets,
SQLite and engines run on the device.

## Run now

Prerequisite for browser development: **Node.js 22.12+** and npm.

```powershell
npm ci
npm run dev
```

Open **http://127.0.0.1:1420** and choose **Open Demo Project**.
The browser version includes the same engines, UI and real SQLite persistence as the desktop
application, using IndexedDB to retain SQLite files across reloads.

1. Select **GO LIVE** in the explorer to activate milestone focus.
2. Observe the ranked marginal contributors; Data Migration is deliberately risky.
3. Keep **Risk Flow** enabled to see transmitted exposure on edges.
4. **Publish Baseline**, then **New Scenario**.
5. Select Data Migration and change duration from 12 to 18 days; commit with Enter or blur.
6. Dates, slack, conflicts and downstream exposure recalculate in a Web Worker.
7. **Compare** shows schedule, risk and activity deltas against the published baseline.
8. **Save**, reload, and open the project from **Recent Projects**. Scenario overrides survive.

### Windows desktop prerequisites

- Node.js and npm as above.
- Rust stable, MSVC toolchain (`rustup`, `cargo`, `rustc` on PATH).
- Visual Studio 2022 Build Tools with **Desktop development with C++** and a Windows SDK.
- Microsoft Edge WebView2 Runtime.

Install Rust through [rustup](https://rustup.rs/) and the C++ prerequisites through the
[Tauri Windows setup guide](https://v2.tauri.app/start/prerequisites/#windows).
Restart the terminal after installation.

```powershell
npm run desktop
npm run desktop:build
```

The Windows NSIS installer is generated under
`apps\desktop\src-tauri\target\release\bundle\nsis`.
The portable executable is under `apps\desktop\src-tauri\target\release`.
Runtime requires WebView2 but no network connection. Dependency installation and initial
native compilation require access to the npm/crates registries.

**Verification status:** the production frontend, engine tests, SQLite round trips and
desktop-sized browser acceptance tests have been executed successfully. Native installer
compilation must be verified on a machine with Rust and Visual C++ build tools; those
prerequisites were absent in the initial development environment. The build reports this
explicitly rather than producing a pretend installer.

## Test and build

```powershell
npm test
npm run build
npm run test:e2e
```

To run the same browser acceptance suite against the compiled production bundle:

```powershell
$env:PLANNER_PREVIEW = '1'
npm run test:e2e
Remove-Item Env:\PLANNER_PREVIEW
```

Vitest covers calendars, all dependency types, lead/lag, constraints, manual and actual dates,
critical/slack passes, validation, risk gating/caps/aggregation, contributors, scenario inheritance,
immutable baseline versions, commands, import/export, SQLite binary reopening and a 1,000-node /
2,994-edge network including 999 mitigation counterfactuals.

Playwright tests the real UI at 1600x1000: demo risk flow, milestone focus, published baseline,
scenario changes, comparison, grid/graph editing and selection, undo, cycle rejection, dependency
editing, save, full reload and recovery. Acceptance coverage also includes row creation in both
views, all four dependency types, automatic layout and reopening a downloaded `.pgplan` SQLite
file. Windows tests use installed Microsoft Edge. On other
platforms install Chromium with `npx playwright install chromium` before running them.

`npm run build` performs strict TypeScript checking followed by the Vite production build.
ELK and AG Grid are sizeable local vendor chunks; no CDN is used.

## Local MCP and shared service

The optional connected mode uses a local authoritative service shared by the UI and VS Code.
Run `npm run service` and connect from the application's service connection controls.
Run the MCP stdio adapter with `npm run mcp`, or use the workspace MCP configuration.
The adapter also supports filtered activity search, diagnostics, metadata, dependency analysis,
duration proposals, operation history, and JSON import requests approved in the connected UI.
See [MCP setup, permissions and limitations](docs/mcp.md).

The service persists working sessions separately from `.pgplan` exports and remains available
when the UI is closed. Separate UI/agent credentials are generated in the current user's
`.whatiftool` directory; never commit or share the connection file. Agents may read and edit
scenarios; changes to the draft, publishing and deletions require explicit user approval.
Revision checks prevent one client from overwriting newer edits. Existing standalone mode
remains available; do not use separate standalone copies as simultaneous writers for a
connected project.

Remote Copilot Studio hosting is a separate deployment stage, not a localhost connection:
it requires an accessible HTTPS Streamable HTTP endpoint, identity/project authorization,
and shared remote persistence. This repository's initial integration is local stdio.

## Features

**Manage Baselines** deletes unused baselines or archives/restores existing ones after typing
the exact baseline name. Baselines referenced by scenarios can only be archived, not deleted.
Archived baselines are hidden from ordinary lists while existing scenarios keep working.
Snapshot contents remain immutable; connected operations are audited and MCP requests require
UI approval.

- React Flow graph: create, connect, edit edges, drag, multi-select, duplicate/delete,
  pan/zoom, fit view, minimap, automatic ELK layout and saved manual positions. Task cards
  show the assigned owner and tags as chips; manage the project tag catalog in **Setup**, assign
  tags from the inspector, and filter the read-only Tags column in the Activity Grid.
- AG Grid Community: create rows, inline edit, sort/filter, multi-select, bulk changes,
  copy selected rows and validated paste of header-based TSV.
- Synchronized graph/grid selection and one normalized Zustand canonical document.
- Inspector: scheduling inputs, calendars, manual/actual dates, constraints, risk factors,
  edge-level explanations and explicit scenario overrides.
- One project team with a working calendar, people and 0–100% allocation; an optional owner
  per activity. Changing effort, owner or availability offers an explicit duration preview.
- Calendar-aware FS, SS, FF and SF, positive/negative lag, forward/backward passes,
  critical and negative slack, visible manual/constraint conflicts.
- Worker-only scheduling/risk/contributor/comparison calculations with stale-result rejection.
- Immutable versioned baselines, copy-on-write inherited scenarios, clone, rename/delete,
  promote to a **new** baseline and baseline comparison.
- Milestone focus dims unrelated nodes and highlights upstream risk paths. Marginal
  contributor analysis reports each ancestor once.
- Local `.pgplan` SQLite files, new/open/save/save-as, recent projects, JSON/CSV exchange,
  and optional once-per-minute auto-save configured in **Setup**.
- Reversible document commands, keyboard undo/redo, validation before mutation, unsaved-change
  guards and visible errors. Ctrl+S saves, Ctrl+Shift+S saves as, Ctrl+O opens, Ctrl+Z/Y undo/redo.

### Team and duration

Use **Team** to define a project team, choose its working calendar and add people with an allocation
percentage. Select an activity and choose its **Owner** in the inspector or grid. Without an owner,
the project calendar and 100% allocation are used for duration proposals.

When effort, owner, allocation or the relevant calendar changes, review the proposal and select
which activities to recalculate. **Keep durations** saves the edit without changing duration or the
activity's previous calendar; **Cancel entire edit** cancels the edit as well. For example, 40 hours
at 50% on an eight-hour calendar yields 10 working days. The calendar accounts for weekends,
holidays and exceptions. Zero allocation cannot produce a proposal; milestones remain at zero
and elapsed activities retain their manually entered durations. Activities are not resource-levelled against
one another. In scenarios the team is isolated from the baseline. CSV replacement imports retain
the durations in the file and do not trigger a proposal.

Changing duration directly recalculates calculated dates, not planned dates. Manual schedules,
actual dates and hard constraints can pin dates and produce visible conflicts.

### Files and recovery

On desktop, **Save** and **Save As** use native dialogs and atomically replace a `.pgplan`
file (SQLite format 3). The app also retains the SQLite document in local WebView IndexedDB
for recent-project recovery. **Setup** can enable auto-save every minute when there are
unsaved changes. It silently updates IndexedDB and, when a `.pgplan` path is already associated,
that file too; it does not open a file dialog. The manual **Save** action still shows its green
confirmation. An explicit file save is the portable backup.

In the browser, **Save** persists to IndexedDB; optional auto-save does the same silently, while
**Save As** opens a file picker to choose the `.pgplan` filename and location in browsers
supporting the File System Access API (such as Edge/Chrome on localhost or HTTPS).
Cancelling leaves the project unsaved. Other browsers download the file using their download
settings and show an explicit notice; **Save** and auto-save still use IndexedDB.
**Open** reads a SQLite project file. JSON exports contain the entire document, including all
baseline versions, settings and overrides. CSV activity/dependency exports use IDs for references;
all CSV exports use UTF-8 with a BOM so Excel recognizes accented and other Unicode characters.
CSV results are read-only calculated output. CSV import replaces one working-draft collection,
rejects invalid graphs atomically and is undoable. Export/import activities before dependencies
when exchanging a complete CSV project with preserved IDs.

Clearing browser/WebView site data removes recent-project storage, so keep `.pgplan` or JSON
backups. Recent projects reopened from local storage ask for a destination on the next native save.

## Stack and structure

Tauri 2 · React 19 · TypeScript · Vite · React Flow · AG Grid **Community** · Zustand ·
ELK.js · SQLite through SQL.js/WASM · Web Worker · Vitest · Playwright.
All dependencies are open-source; no AG Grid Enterprise features or licenses are required.

```text
apps/desktop/
  src/
    components/       shared controls, explorer, dialogs
    graph/            React Flow and ELK adapter
    grid/             AG Grid adapter
    properties/       activity/dependency inspector
    scenarios/        scenario comparison
    store/            normalized document, commands, input parsing
    workers/          typed requests, engine worker, request coordination
    persistence/      native file / IndexedDB adapters
    styles/
  src-tauri/          Rust desktop shell and atomic file writer
packages/
  domain/             plain typed inputs/results, validation, demo
  scheduling/         calendar arithmetic, DAG traversal, scheduling
  risk/               formulas, explanations, marginal contributors
  scenarios/          baseline resolution, overrides, comparisons
  persistence/        repository, SQLite schema, JSON/CSV exchange
tests/
  scheduling/ risk/ scenarios/ persistence/ store/ e2e/
docs/
```

## Engines and domain

The canonical model holds project metadata, activities, dependency edges, calendars, risk settings,
scenarios, field overrides and immutable baseline snapshots. Effort and duration remain independent
unless the user accepts a duration proposal. Milestones have zero duration. Calculated dates are separate engine outputs.
All instants and calendar intervals use **UTC**.

The scheduler validates a DAG, computes predecessor bounds in topological order, then propagates
latest bounds backward from a project/milestone deadline. Zero or negative total slack is critical.
Cached forward input signatures avoid recomputing unrelated branches. Global backward dates and
risk are recalculated because changed terminal dates affect more than descendants.

Intrinsic risk is manual exposure or probability multiplied by capped credible delay/horizon.
Propagation applies slack absorption, exponential spill pressure, a predecessor threshold,
per-edge damping and a transmission cap. Noisy-OR combines incoming transmissions and intrinsic
exposure. A visible schedule-conflict floor escalates infeasible schedules. Every edge exposes
its input factors. **Risk Exposure Score is not a statistically calibrated probability.**

Contributor analysis neutralizes each ancestor's intrinsic risk and delay probability, recomputes
only affected downstream exposures, and ranks the milestone score decrease. Schedule-dependent
edge factors are shared across counterfactuals. Contributions are non-additive.

Scenario resolution applies parent-chain overrides over a referenced baseline snapshot, without
copying the full project for every scenario. Structural changes use explicit entity creation and
tombstone overrides. Historical baselines are never overwritten by promotion.

See [architecture](docs/architecture.md), [domain model](docs/domain-model.md),
[scheduling](docs/scheduling-engine.md), [risk model](docs/risk-model.md) and
[decisions](docs/decisions.md) for formulas, invariants and assumptions.
For an external AI assistant, see the Italian [Researcher import instructions](docs/istruzioni-researcher-importazione.md)
to generate a compatible JSON project for manual review and import.

## Known MVP limitations

- UTC scheduling, not regional timezone/DST calendars; no resource assignment or leveling.
- SUMMARY is a standalone activity, not a computed hierarchical roll-up.
- Calendar editing is a validated JSON editor rather than a full graphical calendar designer.
- Marginal contributions are heuristic mitigation sensitivity, not causal probabilities or
  schedule-remediation estimates. Correlated reconverging paths are not statistically modeled.
- Exact deadline conflicts can dominate risk through the explicit conflict floor.
- Parent scenario changes intentionally flow into inherited clones; delete children before parents.
- Native atomic saves export the complete small SQLite database. This is not a multi-user database.
- Community-grid copy/paste is provided through explicit Copy selected / Paste TSV controls,
  not AG Grid Enterprise's Excel-style range clipboard.
  Copy selected exports all displayed data columns in their current order (including columns
  outside the horizontal viewport), with field-name headers, raw values and empty cells preserved.
  Tabs, line breaks and quotes inside values use quoted TSV escaping. Paste TSV accepts only
  editable field headers; remove calculated/read-only columns before using an export for edits.
  Get Schema (next to Paste TSV) downloads `activity-edit-template.xlsx`. The first sheet,
  Istruzioni, documents each accepted column, allowed values, blank-cell behavior and current
  calendar/owner IDs. The second sheet, Template, contains all editable headers and one example
  row from the first selected activity (or first project activity; an illustrative row if empty).
  Cells use text formatting to preserve ISO dates and IDs. Open it in Excel, keep `code` and the columns
  to update, then copy the header and data cells into Paste TSV.
  Remove unused columns: blank cells clear/reset values rather than leaving them unchanged.
  Use ISO-8601 dates, `true`/`false` for elapsedMode and internal IDs for ownerId/calendarId.
  Paste TSV preserves trailing empty cells and quoted multiline spreadsheet values; it updates
  existing activities by `code` and creates new ones for unknown codes (`name` required).
  Omitted columns on new rows use normal new-activity defaults; explicit blank cells still
  clear/reset values or fail validation for required fields. Duplicate codes in a paste and
  ambiguous existing codes are rejected. Mixed inserts/updates validate atomically, support
  scenarios and one-step Undo/Redo, and retain duration proposals for existing activity edits.
- Automatic layout runs asynchronously on demand; the heavy scheduling/risk algorithms are in a
  worker. No guarantee of instantaneous layout for huge networks is claimed.
- Results are saved with engine versions for provenance but are recalculated when opening a project.
- Desktop installer verification is blocked until the native toolchain is installed.

## Future roadmap (not implemented)

Timezone calendars, native incremental SQLite writes, richer calendar UI, correlated risk,
Monte Carlo, sensitivity visualization, resources/costs, Microsoft Project/Primavera adapters,
remote repositories and portfolio analysis. Authentication, cloud infrastructure, collaboration
and resource leveling are explicitly outside this MVP.
