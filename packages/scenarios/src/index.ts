import { parseProject, snapshot, validateProject, type ActivityComparison, type CalculationResults, type EntityType, type ProjectModel, type ProjectSnapshot, type ScenarioComparison, type ScenarioOverride } from '@planner/domain';
import { activityCalendar, nominalDayHours, scheduleProject, workingDurationBetween } from '@planner/scheduling';
import { calculateProjectRisk } from '@planner/risk';

const fields: Record<EntityType, ReadonlySet<string>> = {
  activity: new Set(['code', 'name', 'description', 'type', 'effortHours', 'duration', 'durationUnit', 'elapsedMode', 'scheduleMode',
    'plannedStart', 'plannedFinish', 'actualStart', 'actualFinish', 'constraintType', 'constraintDate', 'targetDate',
    'intrinsicRisk', 'probabilityOfDelay', 'delayP80', 'calendarId', 'ownerId', 'status', 'graphPosition']),
  dependency: new Set(['predecessorId', 'successorId', 'type', 'lag', 'lagUnit', 'edgeWeight']),
  project: new Set(['name', 'description', 'projectStart', 'targetFinish', 'defaultCalendarId', 'team']),
  settings: new Set(['riskThreshold', 'defaultDamping', 'transmissionCap', 'defaultImpactHorizon', 'riskColorThresholds']),
  calendar: new Set(['name', 'workingDays', 'workingIntervals', 'holidays', 'exceptions']),
};
function applyOverride(m: ProjectSnapshot, o: ScenarioOverride): void {
  const collection = o.entityType === 'activity' ? m.activities : o.entityType === 'dependency' ? m.dependencies : o.entityType === 'calendar' ? m.calendars : undefined;
  if (o.fieldName === '$entity') {
    if (!collection) throw new Error('Only activities, dependencies and calendars support structural overrides.');
    const index = collection.findIndex(x => x.id === o.entityId);
    if (o.value === null) { if (index >= 0) collection.splice(index, 1); return; }
    if (typeof o.value !== 'object' || (o.value as { id?: string }).id !== o.entityId) throw new Error('Invalid entity override.');
    // Validate the fully resolved document after all overrides, allowing atomic graph edits.
    const list = collection as Array<{ id: string }>;
    if (index >= 0) list[index] = structuredClone(o.value) as { id: string };
    else list.push(structuredClone(o.value) as { id: string });
    return;
  }
  if (!fields[o.entityType].has(o.fieldName)) throw new Error(`Scenario field is not editable: ${o.fieldName}`);
  const entity = collection ? collection.find(x => x.id === o.entityId) : o.entityType === 'project' ? m.project : m.settings;
  if (!entity) throw new Error('Scenario override references a missing entity.');
  if (o.value === null) Reflect.deleteProperty(entity, o.fieldName);
  else Reflect.set(entity, o.fieldName, structuredClone(o.value));
}
export function resolveScenario(m: ProjectModel, scenarioId?: string): ProjectSnapshot {
  if (!scenarioId) return snapshot(m);
  const scenarios = new Map(m.scenarios.map(s => [s.id, s]));
  const current = scenarios.get(scenarioId);
  if (!current) throw new Error('Scenario not found.');
  const baseline = m.baselines.find(b => b.id === current.baselineVersionId);
  if (!baseline) throw new Error('Scenario baseline not found.');
  const chain = [current], seen = new Set([current.id]);
  while (chain[0]!.parentScenarioId) {
    const parent = scenarios.get(chain[0]!.parentScenarioId!);
    if (!parent || parent.baselineVersionId !== current.baselineVersionId || seen.has(parent.id)) throw new Error('Invalid scenario inheritance.');
    seen.add(parent.id); chain.unshift(parent);
  }
  const resolved = snapshot(baseline.snapshot);
  for (const s of chain) for (const o of m.overrides.filter(o => o.scenarioId === s.id)) applyOverride(resolved, o);
  validateProject(resolved);
  return resolved;
}
export function validateDocument(m: ProjectModel): void {
  parseProject(m);
  for (const s of m.scenarios) resolveScenario(m, s.id);
}
export function publishBaseline(m: ProjectModel, name: string, sourceId?: string): ProjectModel {
  const next = structuredClone(m), source = resolveScenario(m, sourceId);
  const id = crypto.randomUUID(), createdAt = new Date().toISOString();
  next.baselines.push({ id, name, createdAt, snapshot: source });
  next.scenarios.push({ id: crypto.randomUUID(), projectId: m.project.id, name, baselineVersionId: id, isBaseline: true, createdAt });
  return next;
}
export function createScenario(m: ProjectModel, name: string, parentId?: string): { model: ProjectModel; id: string } {
  let next = structuredClone(m);
  if (!next.baselines.length) next = publishBaseline(next, 'Baseline v1');
  const parent = parentId ? next.scenarios.find(s => s.id === parentId) : undefined;
  if (parentId && !parent) throw new Error('Parent scenario not found.');
  const id = crypto.randomUUID();
  next.scenarios.push({ id, projectId: m.project.id, name, parentScenarioId: parent?.isBaseline ? undefined : parent?.id,
    baselineVersionId: parent?.baselineVersionId ?? next.baselines.at(-1)!.id, isBaseline: false, createdAt: new Date().toISOString() });
  return { model: next, id };
}
export function writeOverride(m: ProjectModel, scenarioId: string, entityType: EntityType, entityId: string, fieldName: string, value: unknown): void {
  const s = m.scenarios.find(s => s.id === scenarioId);
  if (!s || s.isBaseline) throw new Error('Published baseline is immutable. Create a scenario to edit it.');
  if (fieldName === '$entity' && value === null)
    m.overrides = m.overrides.filter(o => !(o.scenarioId === scenarioId && o.entityType === entityType && o.entityId === entityId && o.fieldName !== '$entity'));
  const existing = m.overrides.find(o => o.scenarioId === scenarioId && o.entityType === entityType && o.entityId === entityId && o.fieldName === fieldName);
  if (existing) existing.value = value === undefined ? null : structuredClone(value);
  else m.overrides.push({ id: crypto.randomUUID(), scenarioId, entityType, entityId, fieldName, value: value === undefined ? null : structuredClone(value) });
}
export function deleteScenario(m: ProjectModel, id: string): ProjectModel {
  if (m.scenarios.find(s => s.id === id)?.isBaseline) throw new Error('Published baselines cannot be deleted.');
  if (m.scenarios.some(s => s.parentScenarioId === id)) throw new Error('Delete child scenarios first.');
  return { ...m, scenarios: m.scenarios.filter(s => s.id !== id), overrides: m.overrides.filter(o => o.scenarioId !== id) };
}
export function compareScenarios(base: ProjectSnapshot, scenario: ProjectSnapshot, baseline: CalculationResults, result: CalculationResults, milestoneId?: string): ScenarioComparison {
  const ids = new Set([...base.activities.map(a => a.id), ...scenario.activities.map(a => a.id)]);
  const activities: ActivityComparison[] = [];
  for (const id of ids) {
    const a = base.activities.find(a => a.id === id), b = scenario.activities.find(a => a.id === id);
    const ar = baseline.schedule.activities[id], br = result.schedule.activities[id];
    if (!a || !b || !ar || !br) {
      activities.push({ activityId: id, durationDelta: 0, startDelta: 0, finishDelta: 0, slackDelta: 0, riskDelta: 0, criticalChanged: false, added: !a, removed: !b });
      continue;
    }
    const c = activityCalendar(scenario, b);
    const durationDays = (x: typeof a, model: ProjectSnapshot) => x.durationUnit === 'd' ? x.duration
      : x.duration / (x.elapsedMode ? 24 : nominalDayHours(activityCalendar(model, x)));
    const diff = { activityId: id, durationDelta: durationDays(b, scenario) - durationDays(a, base),
      startDelta: workingDurationBetween(ar.calculatedStart, br.calculatedStart, c),
      finishDelta: workingDurationBetween(ar.calculatedFinish, br.calculatedFinish, c),
      slackDelta: br.totalSlack - ar.totalSlack, riskDelta: result.risk[id]!.totalRisk - baseline.risk[id]!.totalRisk,
      criticalChanged: ar.critical !== br.critical };
    if (Object.entries(diff).some(([k, v]) => k !== 'activityId' && v !== 0 && v !== false)) activities.push(diff);
  }
  const cal = scenario.calendars.find(c => c.id === scenario.project.defaultCalendarId)!;
  const finishA = milestoneId ? baseline.schedule.activities[milestoneId]?.calculatedFinish : baseline.schedule.projectFinish;
  const finishB = milestoneId ? result.schedule.activities[milestoneId]?.calculatedFinish : result.schedule.projectFinish;
  const aggregateRisk = (r: CalculationResults) => milestoneId ? r.risk[milestoneId]?.totalRisk ?? 0 : Math.max(0, ...Object.values(r.risk).map(x => x.totalRisk));
  const critical = (r: CalculationResults) => Object.values(r.schedule.activities).filter(a => a.critical).length;
  const negative = (r: CalculationResults) => Math.min(0, ...Object.values(r.schedule.activities).map(a => a.totalSlack));
  return { baseline, scenario: result, activities, finishDelta: finishA && finishB ? workingDurationBetween(finishA, finishB, cal) : 0,
    riskDelta: aggregateRisk(result) - aggregateRisk(baseline), criticalDelta: critical(result) - critical(baseline), negativeSlackDelta: negative(result) - negative(baseline) };
}
export function calculateComparison(m: ProjectModel, scenarioId: string, milestoneId?: string): ScenarioComparison {
  const s = m.scenarios.find(s => s.id === scenarioId);
  if (!s) throw new Error('Select a scenario to compare.');
  const base = m.baselines.find(b => b.id === s.baselineVersionId)!.snapshot, resolved = resolveScenario(m, scenarioId);
  return compareScenarios(base, resolved, calculateProjectRisk(base, scheduleProject(base), undefined),
    calculateProjectRisk(resolved, scheduleProject(resolved), undefined), milestoneId);
}
