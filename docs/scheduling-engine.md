# Scheduling engine

The scheduler validates input and uses Kahn topological ordering (cycles are errors).
All dates are UTC. Working duration traverses half-open daily intervals and skips holidays;
exceptions replace a day's intervals. A working day is the calendar's nominal daily hours.
Elapsed days are 24 hours. An exact workday finish remains at closing time; a successor
with positive work duration starts at the next working opening.
Finish-based dependencies may retain an opening-time finish after a nonworking gap:
Friday 09:00 to Monday 09:00 still contains one working day. This preserves FF/SF
wall-clock bounds without adding work or shifting pinned/manual dates.

## Forward pass

Each automatic start is the maximum of project start, optional planned start and predecessor bounds:

| Edge | Successor bound |
|---|---|
| FS | predecessor finish + lag |
| SS | predecessor start + lag |
| FF | predecessor finish + lag - successor duration |
| SF | predecessor start + lag - successor duration |

Lag uses the successor calendar. Negative lag is lead. Finish-based bounds are converted
using successor duration and calendar. Planned finish is informational except for manual
finish-only scheduling. Actual dates pin the executed start/finish.

START_NO_EARLIER_THAN imposes a lower bound. MUST_START_ON and MUST_FINISH_ON pin dates,
reporting conflicts instead of silently shifting them. FINISH_NO_LATER_THAN and milestone
target dates are deadline bounds. Manual start (or finish-only start inferred by subtraction)
is retained and violations are reported per edge. Missing manual dates are validation errors.

## Backward pass

Late dates begin at the project target or maximum calculated finish, with additional bounds
for deadlines and exact constraints. FS/SS constrain predecessor finish/start from successor
late start; FF/SF constrain from successor late finish. Manual/actual starts also impose
upper bounds, so fixed-date conflicts propagate negative slack upstream. After a global
pass, selected milestone focus recalculates its ancestor bounds using its target,
falling back to the project deadline and then its calculated finish, preserving
global results on unrelated branches.
Total slack is the minimum start/finish working-time distance to late dates. Manual dependency
shortfalls further bound slack below zero. Zero or negative slack is critical.
Warnings retain expected/actual dates and working-day deltas.

Forward input signatures reuse unaffected branches. Latest dates are intentionally global:
changing the project finish can change slack even on an unrelated branch.
