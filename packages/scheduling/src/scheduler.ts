import { iso, type Activity, type ActivitySchedule, type Calendar, type Dependency, type ProjectSnapshot, type ScheduleResults, type ScheduleViolation } from '@planner/domain';
import { addWorkingDuration as add, subtractWorkingDuration as sub, nextWorkingInstant, workingDurationBetween as between } from './calendarMath';
import { getAncestors, topologicalSort } from './graphValidation';

export const SCHEDULING_ENGINE_VERSION = '1.0.0';
interface ForwardEntry { signature: string; start: string; finish: string; violations: ScheduleViolation[] }
export type ScheduleCache = Map<string, ForwardEntry>;
export const activityCalendar = (m: ProjectSnapshot, a: Activity): Calendar => m.calendars.find(c => c.id === (a.calendarId ?? m.project.defaultCalendarId))!;
const max = (dates: string[]) => iso(Math.max(...dates.map(Date.parse)));
const min = (dates: string[]) => iso(Math.min(...dates.map(Date.parse)));
const durationStart = (finish: string, a: Activity, c: Calendar) => sub(finish, a.duration, a.durationUnit, c, a.elapsedMode);
const durationFinish = (start: string, a: Activity, c: Calendar) => add(start, a.duration, a.durationUnit, c, a.elapsedMode);
export function dependencyCandidate(d: Dependency, p: Pick<ActivitySchedule, 'calculatedStart' | 'calculatedFinish'>, successor: Activity, c: Calendar): string {
  const anchor = d.type[0] === 'F' ? p.calculatedFinish : p.calculatedStart;
  const required = add(anchor, d.lag, d.lagUnit, c);
  return d.type[1] === 'F' ? durationStart(required, successor, c) : required;
}
export function edgeSlack(d: Dependency, m: ProjectSnapshot, results: ScheduleResults, activity?: Activity): number {
  const successor = activity ?? m.activities.find(a => a.id === d.successorId)!;
  const p = results.activities[d.predecessorId]!, s = results.activities[d.successorId]!;
  const c = activityCalendar(m, successor);
  const anchor = d.type[0] === 'F' ? p.calculatedFinish : p.calculatedStart;
  const bound = add(anchor, d.lag, d.lagUnit, c);
  return between(bound, d.type[1] === 'F' ? s.calculatedFinish : s.calculatedStart, c);
}
export function scheduleProject(m: ProjectSnapshot, options: { cache?: ScheduleCache; milestoneId?: string } = {}): ScheduleResults {
  const order = topologicalSort(m), byId = new Map(m.activities.map(a => [a.id, a]));
  const incoming = new Map<string, Dependency[]>(), outgoing = new Map<string, Dependency[]>();
  for (const d of m.dependencies) {
    incoming.set(d.successorId, [...incoming.get(d.successorId) ?? [], d]);
    outgoing.set(d.predecessorId, [...outgoing.get(d.predecessorId) ?? [], d]);
  }
  const result: ScheduleResults = { activities: {}, order, projectFinish: iso(m.project.projectStart), engineVersion: SCHEDULING_ENGINE_VERSION, recalculatedIds: [] };
  Object.setPrototypeOf(result.activities, null);
  for (const id of order) {
    const a = byId.get(id)!, c = activityCalendar(m, a), edges = incoming.get(id) ?? [];
    // Include predecessor dates in signatures: changed durations invalidate only downstream forward dates.
    const signature = JSON.stringify([m.project.projectStart, c, a.duration, a.durationUnit, a.elapsedMode, a.scheduleMode,
      a.plannedStart, a.plannedFinish, a.actualStart, a.actualFinish, a.constraintType, a.constraintDate, a.targetDate,
      edges.map(d => [d, result.activities[d.predecessorId]!.calculatedStart, result.activities[d.predecessorId]!.calculatedFinish])]);
    let entry = options.cache?.get(id);
    if (!entry || entry.signature !== signature) {
      result.recalculatedIds.push(id);
      const bounds = [iso(m.project.projectStart)];
      if (a.plannedStart && a.scheduleMode === 'AUTO') bounds.push(iso(a.plannedStart));
      for (const d of edges) bounds.push(dependencyCandidate(d, result.activities[d.predecessorId]!, a, c));
      if (a.constraintType === 'START_NO_EARLIER_THAN') bounds.push(iso(a.constraintDate!));
      let start = max(bounds);
      if (!a.elapsedMode && a.duration > 0) start = nextWorkingInstant(start, c);
      if (a.scheduleMode === 'MANUAL' && !a.actualStart) start = a.plannedStart ? iso(a.plannedStart) : durationStart(iso(a.plannedFinish!), a, c);
      if (a.constraintType === 'MUST_START_ON') start = iso(a.constraintDate!);
      if (a.constraintType === 'MUST_FINISH_ON') start = durationStart(iso(a.constraintDate!), a, c);
      if (a.actualStart) start = iso(a.actualStart);
      let finish = a.actualFinish ? iso(a.actualFinish)
        : a.constraintType === 'MUST_FINISH_ON' ? iso(a.constraintDate!)
        : a.scheduleMode === 'MANUAL' && !a.plannedStart && !a.actualStart && a.plannedFinish ? iso(a.plannedFinish)
        : durationFinish(start, a, c);
      if (a.scheduleMode === 'AUTO' && !a.actualStart && !a.actualFinish
        && a.constraintType !== 'MUST_START_ON' && a.constraintType !== 'MUST_FINISH_ON') {
        // Subtraction across an overnight gap is not a wall-clock inverse of addition.
        // Retain a finish-based dependency's boundary when working duration is unchanged.
        const finishBounds = edges.filter(d => d.type[1] === 'F').map(d => {
          const p = result.activities[d.predecessorId]!;
          return add(d.type[0] === 'F' ? p.calculatedFinish : p.calculatedStart, d.lag, d.lagUnit, c);
        });
        if (finishBounds.length) finish = max([finish, ...finishBounds]);
      }
      const violations: ScheduleViolation[] = [];
      const report = (type: ScheduleViolation['type'], message: string, expected: string, actual: string, dependencyId?: string) =>
        violations.push({ activityId: id, type, severity: 'error', message, expectedDate: expected, actualDate: actual, dependencyId, deltaDays: Math.abs(between(expected, actual, c)) });
      for (const d of edges) {
        const p = result.activities[d.predecessorId]!;
        const bound = add(d.type[0] === 'F' ? p.calculatedFinish : p.calculatedStart, d.lag, d.lagUnit, c);
        const actual = d.type[1] === 'F' ? finish : start;
        if (Date.parse(actual) < Date.parse(bound)) report('DEPENDENCY', `${a.code} ${d.type} dependency conflicts with ${byId.get(d.predecessorId)!.code}.`, bound, actual, d.id);
      }
      if (Date.parse(finish) < Date.parse(start)) report('ACTUAL', `${a.code} actual finish is before calculated start.`, start, finish);
      if (a.constraintDate) {
        const date = iso(a.constraintDate);
        if ((a.constraintType === 'MUST_START_ON' && start !== date) || (a.constraintType === 'START_NO_EARLIER_THAN' && Date.parse(start) < Date.parse(date)))
          report('CONSTRAINT', `${a.code} start constraint conflicts with scheduled dates.`, date, start);
        if ((a.constraintType === 'MUST_FINISH_ON' && finish !== date) || (a.constraintType === 'FINISH_NO_LATER_THAN' && Date.parse(finish) > Date.parse(date)))
          report('CONSTRAINT', `${a.code} finish constraint conflicts with scheduled dates.`, date, finish);
      }
      if (a.targetDate && Date.parse(finish) > Date.parse(a.targetDate)) report('CONSTRAINT', `${a.code} misses its target date.`, iso(a.targetDate), finish);
      entry = { signature, start, finish, violations };
      options.cache?.set(id, entry);
    }
    result.activities[id] = { activityId: id, calculatedStart: entry.start, calculatedFinish: entry.finish,
      lateStart: entry.start, lateFinish: entry.finish, totalSlack: 0, critical: true, violations: structuredClone(entry.violations) };
  }
  if (order.length) result.projectFinish = max(order.map(id => result.activities[id]!.calculatedFinish));
  const focus = options.milestoneId;
  if (focus && !byId.has(focus)) throw new Error('Selected milestone does not exist.');
  const relevant = focus ? new Set([focus, ...getAncestors(focus, m.dependencies)]) : new Set(order);
  const deadline = focus ? byId.get(focus)!.targetDate ?? m.project.targetFinish ?? result.activities[focus]!.calculatedFinish : m.project.targetFinish ?? result.projectFinish;
  const backward = (scope: Set<string>, target: string) => {
    for (const id of [...order].reverse()) {
      if (!scope.has(id)) continue;
      const a = byId.get(id)!, c = activityCalendar(m, a), r = result.activities[id]!;
      const finishBounds = [iso(target)], startBounds: string[] = [];
      if (a.targetDate) finishBounds.push(iso(a.targetDate));
      if ((a.constraintType === 'FINISH_NO_LATER_THAN' || a.constraintType === 'MUST_FINISH_ON') && a.constraintDate) finishBounds.push(iso(a.constraintDate));
      if (a.constraintType === 'MUST_START_ON' && a.constraintDate) startBounds.push(iso(a.constraintDate));
      if (a.scheduleMode === 'MANUAL' || a.actualStart) startBounds.push(r.calculatedStart);
      if (a.actualFinish) finishBounds.push(r.calculatedFinish);
      for (const d of outgoing.get(id) ?? []) {
        if (!scope.has(d.successorId)) continue;
        const s = result.activities[d.successorId]!, sc = activityCalendar(m, byId.get(d.successorId)!);
        const bound = sub(d.type[1] === 'F' ? s.lateFinish : s.lateStart, d.lag, d.lagUnit, sc);
        if (d.type[0] === 'F') finishBounds.push(bound); else startBounds.push(bound);
      }
      let lf = min(finishBounds), ls = durationStart(lf, a, c);
      if (startBounds.length) {
        ls = min([ls, ...startBounds]);
        lf = min([lf, durationFinish(ls, a, c)]);
      }
      r.lateStart = ls; r.lateFinish = lf;
      r.totalSlack = Math.min(between(r.calculatedStart, ls, c, a.elapsedMode), between(r.calculatedFinish, lf, c, a.elapsedMode));
      for (const v of r.violations) r.totalSlack = Math.min(r.totalSlack, -(v.deltaDays ?? 0));
      r.totalSlack = Math.abs(r.totalSlack) < 1e-8 ? 0 : r.totalSlack;
      r.critical = r.totalSlack <= 0;
    }
  };
  backward(new Set(order), m.project.targetFinish ?? result.projectFinish);
  if (focus) backward(relevant, deadline);
  if (options.cache) for (const key of options.cache.keys()) if (!byId.has(key)) options.cache.delete(key);
  return result;
}
