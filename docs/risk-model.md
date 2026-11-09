# Risk Exposure Score

The score is deterministic, explainable and **not a statistically calibrated probability**.
All internal risk values use [0,1]; public scores use [0,100].

Intrinsic risk is `q * min(1, delayP80 / H)` or a manual override divided by 100.
`H` defaults to five nominal working days. Delay P80 is measured in nominal working days.

For each dependency, edge slack is the successor's actual scheduled bound minus its required
predecessor bound, measured on the successor calendar. Negative slack is preserved.
Current drift is positive predecessor finish drift against planned finish (zero when absent).
`forecastDelay = drift + delayP80`; `spill = max(0, forecastDelay - edgeSlack)`.
`pressure = 1 - exp(-spill/H)`.
Only predecessor scores at or above the configurable threshold (default .50) propagate.
`T = min(cap, damping * edgeWeight * q * gate(Rp) * pressure)`.
Default damping is .80, weight 1 and cap .95.

Incoming transmissions combine with noisy-OR: `P = 1 - product(1-T)`.
Total risk is `1 - (1-I)*(1-P)`. Each edge records all factors for inspection and risk-flow rendering.
Manual/constraint conflicts impose an explicit intrinsic floor proportional to schedule shortfall/H.
The explanation identifies this conflict floor separately; it never silently rewrites user risk.

Multi-hop risk is gated and damped on every edge. Noisy-OR treats incoming exposures as a heuristic,
not independent probabilities. Reconverging paths can share causes; contributor analysis avoids
double-counting by reporting each ancestor once. Contributions are **not additive**.
For each unique ancestor, set intrinsic risk and delay probability to zero, recompute risk and
rank the milestone score decrease. This is a risk-mitigation sensitivity, not schedule remediation.
The isolated implementation can later be replaced with a correlated model or Monte Carlo analysis.
