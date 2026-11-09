import type { ProjectSnapshot, ProjectModel, WorkingInterval } from './index';

const fail = (message: string): never => { throw new Error(message); };
const finite = (n: unknown, min: number, max = Infinity) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
const date = (d: unknown) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}(T.*)?$/.test(d) && Number.isFinite(Date.parse(d))
  && new Date(d).toISOString().slice(0, 10) === d.slice(0, 10);
const unique = (ids: string[], label: string) => {
  if (ids.some(id => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== ids.length) fail(`Invalid or duplicate ${label} IDs.`);
};
function intervalsValid(intervals: WorkingInterval[]) {
  let end = -1;
  for (const i of intervals) {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(i.start) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(i.end)) return false;
    const minutes = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
    const start = minutes(i.start), finish = minutes(i.end);
    if (start >= finish || start < end) return false;
    end = finish;
  }
  return true;
}
export function validateProject(m: ProjectSnapshot): void {
  if (!m?.project || !Array.isArray(m.activities) || !Array.isArray(m.dependencies) || !Array.isArray(m.calendars) || !m.settings)
    fail('Invalid project structure.');
  if (!m.project.name?.trim() || !m.project.id) fail('Project name and ID are required.');
  if (!date(m.project.projectStart) || (m.project.targetFinish && !date(m.project.targetFinish))) fail('Invalid project dates.');
  unique(m.activities.map(a => a.id), 'activity');
  unique(m.dependencies.map(d => d.id), 'dependency');
  unique(m.calendars.map(c => c.id), 'calendar');
  const calendars = new Set(m.calendars.map(c => c.id));
  if (!calendars.has(m.project.defaultCalendarId)) fail('Default calendar is missing.');
  for (const c of m.calendars) {
    if (!c.workingDays?.length || c.workingDays.some(d => !Number.isInteger(d) || d < 0 || d > 6)
      || !c.workingIntervals?.length || !intervalsValid(c.workingIntervals)) fail(`Invalid working calendar ${c.name}.`);
    if (!Array.isArray(c.holidays) || c.holidays.some(d => !date(d))) fail(`Invalid holiday in ${c.name}.`);
    if (!Array.isArray(c.exceptions) || c.exceptions.some(e => !date(e.date) || !intervalsValid(e.intervals))) fail(`Invalid calendar exception in ${c.name}.`);
    unique(c.exceptions.map(e => e.date), 'calendar exception');
  }
  for (const a of m.activities) {
    if (a.projectId !== m.project.id) fail(`Activity ${a.code} belongs to another project.`);
    if (!a.name?.trim() || !a.code?.trim()) fail('Activity name and code are required.');
    if (!['TASK', 'MILESTONE', 'SUMMARY'].includes(a.type)) fail(`Invalid activity type: ${a.code}.`);
    if (!['AUTO', 'MANUAL'].includes(a.scheduleMode) || !['d', 'h'].includes(a.durationUnit) || typeof a.elapsedMode !== 'boolean') fail(`Invalid scheduling options: ${a.code}.`);
    if (a.status && !['NOT_STARTED', 'IN_PROGRESS', 'COMPLETE'].includes(a.status)) fail(`Invalid activity status: ${a.code}.`);
    if (!finite(a.duration, 0) || !finite(a.effortHours, 0)) fail(`Duration and effort must be non-negative: ${a.code}.`);
    if (a.type === 'MILESTONE' && a.duration !== 0) fail(`Milestone ${a.code} must have zero duration.`);
    if (a.calendarId && !calendars.has(a.calendarId)) fail(`Missing calendar: ${a.code}.`);
    if (!a.graphPosition || !finite(a.graphPosition.x, -Infinity) || !finite(a.graphPosition.y, -Infinity)) fail(`Invalid graph position: ${a.code}.`);
    for (const key of ['plannedStart', 'plannedFinish', 'actualStart', 'actualFinish', 'constraintDate', 'targetDate'] as const)
      if (a[key] && !date(a[key])) fail(`Invalid ${key}: ${a.code}.`);
    if (a.plannedStart && a.plannedFinish && Date.parse(a.plannedFinish) < Date.parse(a.plannedStart)) fail(`Activity ${a.code} cannot finish before it starts.`);
    if (a.actualStart && a.actualFinish && Date.parse(a.actualFinish) < Date.parse(a.actualStart)) fail(`Invalid actual dates: ${a.code}.`);
    if (a.scheduleMode === 'MANUAL' && !a.plannedStart && !a.plannedFinish && !a.actualStart) fail(`Manual activity ${a.code} requires a planned start or finish.`);
    if (a.constraintType && !['ASAP', 'START_NO_EARLIER_THAN', 'FINISH_NO_LATER_THAN', 'MUST_START_ON', 'MUST_FINISH_ON'].includes(a.constraintType)) fail(`Invalid constraint: ${a.code}.`);
    if (a.constraintType && a.constraintType !== 'ASAP' && !a.constraintDate) fail(`Constraint date required: ${a.code}.`);
    if (a.probabilityOfDelay !== undefined && !finite(a.probabilityOfDelay, 0, 1)) fail(`Delay probability must be 0-1: ${a.code}.`);
    if (a.intrinsicRisk !== undefined && !finite(a.intrinsicRisk, 0, 100)) fail(`Intrinsic risk must be 0-100: ${a.code}.`);
    if (a.delayP80 !== undefined && !finite(a.delayP80, 0)) fail(`Delay P80 must be non-negative: ${a.code}.`);
  }
  const ids = new Set(m.activities.map(a => a.id));
  const pairs = new Set<string>();
  const outgoing = new Map<string, string[]>(), indegree = new Map(m.activities.map(a => [a.id, 0]));
  for (const d of m.dependencies) {
    if (d.projectId !== m.project.id) fail('Dependency belongs to another project.');
    if (!ids.has(d.predecessorId) || !ids.has(d.successorId)) fail('Dependency references a missing predecessor or successor.');
    if (d.predecessorId === d.successorId) fail('Self dependencies are not allowed.');
    const pair = JSON.stringify([d.predecessorId, d.successorId]);
    if (pairs.has(pair)) fail('Duplicate dependencies are not allowed.');
    pairs.add(pair);
    if (!['FS', 'SS', 'FF', 'SF'].includes(d.type) || !['d', 'h'].includes(d.lagUnit) || !finite(d.lag, -Infinity)
      || (d.edgeWeight !== undefined && !finite(d.edgeWeight, 0, 1))) fail('Invalid dependency type, lag or edge weight.');
    outgoing.set(d.predecessorId, [...outgoing.get(d.predecessorId) ?? [], d.successorId]);
    indegree.set(d.successorId, indegree.get(d.successorId)! + 1);
  }
  const queue = [...indegree].filter(([, n]) => n === 0).map(([id]) => id);
  for (let i = 0; i < queue.length; i++) for (const id of outgoing.get(queue[i]!) ?? []) {
    indegree.set(id, indegree.get(id)! - 1);
    if (indegree.get(id) === 0) queue.push(id);
  }
  if (queue.length !== ids.size) fail('Dependency rejected because it would create a cycle.');
  for (const key of ['riskThreshold', 'defaultDamping', 'transmissionCap'] as const)
    if (!finite(m.settings[key], 0, 1)) fail(`Invalid risk setting: ${key}.`);
  if (!finite(m.settings.defaultImpactHorizon, .001)) fail('Impact horizon must be positive.');
  const t = m.settings.riskColorThresholds;
  if (!Array.isArray(t) || t.length !== 3 || !t.every(n => finite(n, 0, 100)) || !(t[0]! < t[1]! && t[1]! < t[2]!))
    fail('Risk color thresholds must be three ascending scores.');
}
export function parseProject(value: unknown): ProjectModel {
  if (typeof value !== 'object' || value === null) fail('Expected a project document.');
  const m = value as ProjectModel;
  if (m.schemaVersion !== 1 || !Array.isArray(m.scenarios) || !Array.isArray(m.overrides) || !Array.isArray(m.baselines)) fail('Unsupported project document version.');
  validateProject(m);
  unique(m.scenarios.map(s => s.id), 'scenario');
  unique(m.baselines.map(b => b.id), 'baseline');
  unique(m.overrides.map(o => o.id), 'override');
  for (const b of m.baselines) {
    if (!b.name || !date(b.createdAt)) fail('Invalid baseline metadata.');
    validateProject(b.snapshot);
    if (b.snapshot.project.id !== m.project.id) fail('Baseline belongs to a different project.');
  }
  const scenarios = new Map(m.scenarios.map(s => [s.id, s]));
  for (const s of m.scenarios) {
    if (!s.name?.trim() || s.projectId !== m.project.id || !m.baselines.some(b => b.id === s.baselineVersionId)
      || !date(s.createdAt) || typeof s.isBaseline !== 'boolean') fail('Invalid scenario baseline or metadata.');
    if (s.isBaseline && s.parentScenarioId) fail('Published baselines cannot inherit scenario overrides.');
    const seen = new Set<string>([s.id]);
    let parent = s.parentScenarioId;
    while (parent) {
      if (seen.has(parent)) fail('Scenario inheritance cycle.');
      seen.add(parent);
      const p = scenarios.get(parent);
      if (!p || p.baselineVersionId !== s.baselineVersionId) fail('Missing or incompatible parent scenario.');
      parent = p!.parentScenarioId;
    }
  }
  for (const o of m.overrides) {
    if (!scenarios.has(o.scenarioId) || scenarios.get(o.scenarioId)!.isBaseline) fail('Override references missing or immutable scenario.');
    if (!['activity', 'dependency', 'project', 'settings', 'calendar'].includes(o.entityType) || typeof o.entityId !== 'string'
      || typeof o.fieldName !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(o.fieldName)) fail('Invalid scenario override.');
  }
  return structuredClone(m);
}
