import { scheduleProject, type ScheduleCache } from '@planner/scheduling';
import { calculateProjectRisk } from '@planner/risk';
import { calculateComparison, resolveScenario } from '@planner/scenarios';
import type { CalculationRequest, CalculationResponse } from './messages';
const caches = new Map<string, ScheduleCache>();
self.onmessage = ({ data: r }: MessageEvent<CalculationRequest>) => {
  let response: CalculationResponse;
  try {
    if (r.type === 'COMPARE_SCENARIOS') {
      if (!r.scenarioId) throw new Error('Select a scenario or baseline to compare.');
      response = { type: 'COMPARISON', requestId: r.requestId, revision: r.revision,
        comparison: calculateComparison(r.model, r.scenarioId, r.milestoneId) };
    } else {
      const m = resolveScenario(r.model, r.scenarioId);
      const key = `${m.project.id}:${r.scenarioId ?? 'draft'}`;
      const cache = caches.get(key) ?? new Map();
      caches.set(key, cache);
      if (caches.size > 12) caches.delete(caches.keys().next().value!);
      response = { type: 'RESULT', requestId: r.requestId, revision: r.revision,
        results: { ...calculateProjectRisk(m, scheduleProject(m, { cache, milestoneId: r.milestoneId }), r.milestoneId), scenarioId: r.scenarioId } };
    }
  } catch (error) {
    response = { type: 'ERROR', requestId: r.requestId, revision: r.revision, message: error instanceof Error ? error.message : String(error) };
  }
  self.postMessage(response);
};
