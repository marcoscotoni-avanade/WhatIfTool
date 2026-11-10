# Canonical domain model

`ProjectModel` contains project metadata, activities, dependencies, calendars, scenarios,
copy-on-write overrides, immutable baseline versions and risk settings. Engine results are separate.
The store normalizes activity, dependency and scenario collections; views resolve the same document.

Activity types are TASK, MILESTONE and SUMMARY. SUMMARY is a standalone activity in the MVP,
not an automatic roll-up. Milestones have zero duration and optional target dates.
Effort and duration are independent inputs; an explicit user-approved proposal can calculate
duration from effort, owner allocation and the applicable working calendar. Durations and lags use hours or days.
Dates are ISO-8601 UTC instants; date-only input means 09:00 UTC. The UI explicitly labels UTC.
Calendar working days use JavaScript numbering (Sunday = 0).

An optional `project.team` contains `name`, `calendarId` and `members`, each with a unique
`id`, `name` and `allocationPercent` between 0 and 100. An optional activity `ownerId` refers
to one team member. `project.tagCatalog` is the project-scoped list of unique, non-empty tag
names; optional task `tags` references zero or more catalog entries. Setup manages the catalog;
the task inspector assigns tags from a multi-select list, and task cards render them as chips.
The Activity Grid exposes a read-only comma-separated Tags value for filtering. Removing a
catalog entry removes its assignments from tasks. Team metadata and the tag catalog are part of
project snapshots and can be overridden in a scenario. Older schema version 1 documents without
a team or catalog remain valid; existing task tags seed a missing catalog during loading.

Dependencies are directed FS, SS, FF or SF edges. Self-edges, duplicate directed pairs,
missing endpoints and cycles are rejected. Negative lag is supported.
Calendars have weekly working intervals, holidays and date-specific replacement intervals.

Published baselines snapshot input collections, settings and project scheduling metadata. Historical
versions cannot be edited or deleted. Scenarios reference a baseline version, optionally inherit a
parent scenario and store only field-level overrides (including `$entity` creation/deletion overrides).
Resolution is baseline + ancestors' overrides + scenario overrides; derived dates are never stored as overrides.
Baseline promotion creates a new immutable version rather than overwriting history.
