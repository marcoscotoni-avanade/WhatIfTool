import { z } from 'zod';
import type { CalculationResults, ProjectSnapshot } from '@planner/domain';

const page = { scenarioId: z.string().min(1).nullable(), limit: z.number().int().min(1).max(100), offset: z.number().int().nonnegative() };
export const dependencyQuerySchema = z.object({
  ...page, predecessorId: z.string().min(1).optional(), successorId: z.string().min(1).optional(),
  activityId: z.string().min(1).optional(), type: z.enum(['FS', 'SS', 'FF', 'SF']).optional(),
  traversal: z.object({ activityId: z.string().min(1), direction: z.enum(['ancestors', 'descendants']),
    maxDepth: z.number().int().min(1).max(50) }).strict().optional(),
  analyze: z.boolean(),
}).strict();
export const diagnosticQuerySchema = z.object({ ...page, milestoneId: z.string().min(1).optional() }).strict();
type DependencyQuery = z.infer<typeof dependencyQuerySchema>;

export function queryDependencies(snapshot: ProjectSnapshot, query: DependencyQuery, calculation?: CalculationResults) {
  let reachable: Set<string> | undefined;
  if (query.traversal) {
    if (!snapshot.activities.some(activity => activity.id === query.traversal!.activityId)) throw new Error('Traversal activity not found.');
    reachable = new Set<string>();
    let frontier = new Set([query.traversal.activityId]);
    const visited = new Set(frontier);
    for (let depth = 0; depth < query.traversal.maxDepth && frontier.size; depth++) {
      const next = new Set<string>();
      for (const edge of snapshot.dependencies) {
        const from = query.traversal.direction === 'descendants' ? edge.predecessorId : edge.successorId;
        const to = query.traversal.direction === 'descendants' ? edge.successorId : edge.predecessorId;
        if (frontier.has(from)) {
          reachable.add(edge.id);
          if (!visited.has(to)) { visited.add(to); next.add(to); }
        }
      }
      frontier = next;
    }
  }
  const items = snapshot.dependencies.filter(edge =>
    (!query.predecessorId || edge.predecessorId === query.predecessorId)
    && (!query.successorId || edge.successorId === query.successorId)
    && (!query.activityId || edge.predecessorId === query.activityId || edge.successorId === query.activityId)
    && (!query.type || edge.type === query.type) && (!reachable || reachable.has(edge.id)))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    .map(edge => calculation ? { ...edge, predecessorSchedule: calculation.schedule.activities[edge.predecessorId],
      successorSchedule: calculation.schedule.activities[edge.successorId] } : edge);
  return { items: items.slice(query.offset, query.offset + query.limit), total: items.length,
    limit: query.limit, offset: query.offset, scenarioId: query.scenarioId };
}

export function diagnose(snapshot: ProjectSnapshot, result: CalculationResults, milestoneId?: string) {
  const issues: { code: string; severity: 'warning' | 'error' | 'info'; activityId?: string; dependencyId?: string; evidence?: unknown; message: string }[] = [];
  const connected = new Set(snapshot.dependencies.flatMap(edge => [edge.predecessorId, edge.successorId]));
  const upstream = new Set<string>();
  if (milestoneId) {
    let frontier = [milestoneId];
    upstream.add(milestoneId);
    while (frontier.length) {
      const next: string[] = [];
      for (const edge of snapshot.dependencies) if (frontier.includes(edge.successorId) && !upstream.has(edge.predecessorId)) {
        upstream.add(edge.predecessorId); next.push(edge.predecessorId);
      }
      frontier = next;
    }
  }
  for (const activity of snapshot.activities) {
    const schedule = result.schedule.activities[activity.id];
    if (!schedule) continue;
    for (const violation of schedule.violations) issues.push({ code: `SCHEDULE_${violation.type}`, severity: violation.severity,
      activityId: activity.id, dependencyId: violation.dependencyId, evidence: violation, message: violation.message });
    if (schedule.totalSlack < 0) issues.push({ code: 'NEGATIVE_SLACK', severity: 'warning', activityId: activity.id,
      evidence: { totalSlack: schedule.totalSlack }, message: 'Activity has negative total slack.' });
    if (activity.plannedStart && Date.parse(schedule.calculatedStart) > Date.parse(activity.plannedStart))
      issues.push({ code: 'PLANNED_START_EXCEEDED', severity: 'warning', activityId: activity.id,
        evidence: { plannedStart: activity.plannedStart, calculatedStart: schedule.calculatedStart }, message: 'Calculated start exceeds planned start.' });
    if (activity.plannedFinish && Date.parse(schedule.calculatedFinish) > Date.parse(activity.plannedFinish))
      issues.push({ code: 'PLANNED_FINISH_EXCEEDED', severity: 'warning', activityId: activity.id,
        evidence: { plannedFinish: activity.plannedFinish, calculatedFinish: schedule.calculatedFinish }, message: 'Calculated finish exceeds planned finish.' });
    if (activity.targetDate && Date.parse(schedule.calculatedFinish) > Date.parse(activity.targetDate))
      issues.push({ code: 'TARGET_EXCEEDED', severity: 'warning', activityId: activity.id,
        evidence: { targetDate: activity.targetDate, calculatedFinish: schedule.calculatedFinish }, message: 'Calculated finish exceeds target date.' });
    if (!connected.has(activity.id)) issues.push({ code: 'ISOLATED_ACTIVITY', severity: 'info', activityId: activity.id, message: 'Activity has no dependencies.' });
    if (milestoneId && !upstream.has(activity.id)) issues.push({ code: 'NOT_LINKED_TO_MILESTONE', severity: 'info', activityId: activity.id, message: 'Activity is not upstream of the selected milestone.' });
    if (activity.type === 'MILESTONE' && !activity.targetDate) issues.push({ code: 'MILESTONE_WITHOUT_TARGET', severity: 'info', activityId: activity.id, message: 'Milestone has no target date.' });
    if (activity.type === 'TASK' && activity.duration === 0) issues.push({ code: 'ZERO_TASK_DURATION', severity: 'warning', activityId: activity.id, message: 'Task has zero duration.' });
  }
  return issues.sort((a, b) => (a.activityId ?? '').localeCompare(b.activityId ?? '') || a.code.localeCompare(b.code)
    || (a.dependencyId ?? '').localeCompare(b.dependencyId ?? ''));
}
