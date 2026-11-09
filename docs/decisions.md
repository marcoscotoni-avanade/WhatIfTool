# Decision log

## Explicit team duration proposals
**Decision:** one optional project team, one optional activity owner, and opt-in duration conversion.
**Reason:** effort, duration and availability are distinct inputs; user decisions remain reversible.
**Consequences:** no resource levelling; team and owner are optional version-1 JSON payload fields,
so existing files and baseline snapshots require no destructive migration.

## UTC working instants
**Decision:** ISO UTC instants with configurable work intervals; date-only means 09:00 UTC.
**Reason:** deterministic calculations across machines and DST boundaries.
**Alternatives:** local timezone arithmetic.
**Consequences:** UI labels UTC; regional timezone scheduling is future work.

## Working day and elapsed duration
**Decision:** nominal weekly interval hours define a working day; elapsed day = 24h.
**Reason:** preserve conventional five-day/eight-hour planning while supporting hours and split shifts.
**Alternatives:** inclusive whole-date counting.
**Consequences:** finishes are exclusive instants, not inclusive displayed date ranges.
An FF/SF opening-time boundary can include a nonworking gap after the work completes;
the elapsed instant bound and exact working duration both remain satisfied.

## Manual and hard-constraint conflicts
**Decision:** retain requested dates, report edge violations, negative slack and intrinsic risk floor.
**Reason:** never conceal incompatible input.
**Alternatives:** silently move dates or reject all conflicting plans.
**Consequences:** the model can represent an infeasible schedule and explain it.

## SQLite portability
**Decision:** use SQL.js SQLite with native Tauri file IO; browser dev uses IndexedDB.
**Reason:** one database format and migration path, no SQL-server requirement or separate backend.
**Alternatives:** native-only SQL plugin.
**Consequences:** database writes export a complete small MVP file; very large databases may
benefit from a native repository implementation later. Repository interface remains unchanged.

## Baseline and scenario semantics
**Decision:** immutable version snapshots, field overrides, single-parent inheritance, explicit entity tombstones.
**Reason:** copy-on-write without losing historical baselines or breaking structural what-if edits.
**Alternatives:** full scenario copies or mutable baseline.
**Consequences:** promotion creates a version; existing scenarios continue referencing their historical base.

## Risk semantics
**Decision:** delay probabilities are fractions, delays/horizons are working days; manual overrides are scores.
**Reason:** match supplied deterministic formulas. Default H=5d; risk settings live on project.
**Alternatives:** calibrated probability or stochastic simulation.
**Consequences:** noisy-OR and marginal contributions are heuristic and non-additive.

## Incremental scope
**Decision:** reuse unaffected forward dates; recompute global backward pass and downstream risk.
**Reason:** an altered terminal finish changes slack outside the forward descendant set.
**Alternatives:** reuse stale latest dates or always recompute forward pass.
**Consequences:** correctness takes priority over an over-aggressive incremental cache.
