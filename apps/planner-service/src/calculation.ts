import { parentPort, workerData } from 'node:worker_threads';
import { scheduleProject } from '@planner/scheduling';
import { calculateProjectRisk } from '@planner/risk';
import { calculateComparison, resolveScenario } from '@planner/scenarios';
import type { ProjectModel } from '@planner/domain';

const request = workerData as { model: ProjectModel; scenarioId?: string; milestoneId?: string; compare: boolean };
try {
  const resolved = resolveScenario(request.model, request.scenarioId);
  if (request.milestoneId && !resolved.activities.some(a => a.id === request.milestoneId && a.type === 'MILESTONE'))
    throw new Error('Milestone not found.');
  if (request.compare) {
    if (!request.scenarioId) throw new Error('Select a scenario to compare.');
    parentPort!.postMessage({ result: calculateComparison(request.model, request.scenarioId, request.milestoneId) });
  } else parentPort!.postMessage({ result: {
    ...calculateProjectRisk(resolved, scheduleProject(resolved, { milestoneId: request.milestoneId }), request.milestoneId),
    scenarioId: request.scenarioId,
  } });
} catch (error) {
  parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
