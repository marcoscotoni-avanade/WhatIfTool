export type DurationUnit = 'd' | 'h';
export type DependencyType = 'FS' | 'SS' | 'FF' | 'SF';
export type ConstraintType = 'ASAP' | 'START_NO_EARLIER_THAN' | 'FINISH_NO_LATER_THAN' | 'MUST_START_ON' | 'MUST_FINISH_ON';
export interface Project {
  id: string; name: string; description?: string; projectStart: string; targetFinish?: string;
  defaultCalendarId: string; createdAt: string; modifiedAt: string; team?: Team; tagCatalog?: string[];
}
export interface TeamMember { id: string; name: string; allocationPercent: number }
export interface Team { name: string; calendarId: string; members: TeamMember[] }
export interface Activity {
  id: string; projectId: string; code: string; name: string; description?: string; tags?: string[];
  type: 'TASK' | 'MILESTONE' | 'SUMMARY';
  effortHours: number; duration: number; durationUnit: DurationUnit; elapsedMode: boolean;
  scheduleMode: 'AUTO' | 'MANUAL';
  plannedStart?: string; plannedFinish?: string; actualStart?: string; actualFinish?: string;
  constraintType?: ConstraintType; constraintDate?: string; targetDate?: string;
  intrinsicRisk?: number; probabilityOfDelay?: number; delayP80?: number; calendarId?: string; ownerId?: string;
  status?: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETE'; graphPosition: { x: number; y: number };
}
export interface Dependency {
  id: string; projectId: string; predecessorId: string; successorId: string;
  type: DependencyType; lag: number; lagUnit: DurationUnit; edgeWeight?: number;
}
export interface WorkingInterval { start: string; end: string }
export interface CalendarException { date: string; intervals: WorkingInterval[] }
export interface Calendar {
  id: string; name: string; workingDays: number[]; workingIntervals: WorkingInterval[];
  holidays: string[]; exceptions: CalendarException[];
}
export interface RiskSettings {
  riskThreshold: number; defaultDamping: number; transmissionCap: number;
  defaultImpactHorizon: number; riskColorThresholds: [number, number, number];
}
export const DEFAULT_RISK_SETTINGS: RiskSettings = {
  riskThreshold: .5, defaultDamping: .8, transmissionCap: .95,
  defaultImpactHorizon: 5, riskColorThresholds: [25, 50, 75],
};
export interface Scenario {
  id: string; projectId: string; name: string; description?: string;
  parentScenarioId?: string; baselineVersionId: string; isBaseline: boolean; createdAt: string;
}
export type EntityType = 'activity' | 'dependency' | 'project' | 'settings' | 'calendar';
export interface ScenarioOverride {
  id: string; scenarioId: string; entityType: EntityType; entityId: string; fieldName: string; value: unknown;
}
export interface BaselineVersion {
  id: string; name: string; createdAt: string; snapshot: ProjectSnapshot; archived?: boolean;
}
export interface ProjectSnapshot {
  project: Project; activities: Activity[]; dependencies: Dependency[]; calendars: Calendar[]; settings: RiskSettings;
}
export interface ProjectModel extends ProjectSnapshot {
  schemaVersion: 1; scenarios: Scenario[]; overrides: ScenarioOverride[]; baselines: BaselineVersion[];
}
export interface ScheduleViolation {
  activityId: string; type: 'DEPENDENCY' | 'CONSTRAINT' | 'MANUAL' | 'ACTUAL';
  severity: 'warning' | 'error'; message: string; dependencyId?: string;
  expectedDate?: string; actualDate?: string; deltaDays?: number;
}
export interface ActivitySchedule {
  activityId: string; calculatedStart: string; calculatedFinish: string;
  lateStart: string; lateFinish: string; totalSlack: number; critical: boolean;
  violations: ScheduleViolation[];
}
export interface ScheduleResults {
  activities: Record<string, ActivitySchedule>; order: string[]; projectFinish: string;
  engineVersion: string; recalculatedIds: string[];
}
export interface RiskContributor {
  dependencyId: string; predecessorId: string; predecessorRisk: number; probabilityOfDelay: number;
  delayP80: number; currentDrift: number; availableSlack: number; spill: number; pressure: number;
  damping: number; transmittedRisk: number;
}
export interface RiskExplanation {
  activityId: string; totalRisk: number; intrinsicRisk: number; propagatedRisk: number;
  conflictRisk: number; contributors: RiskContributor[];
}
export interface MilestoneContributor { activityId: string; contribution: number; rank: number }
export interface CalculationResults {
  schedule: ScheduleResults; risk: Record<string, RiskExplanation>; riskEngineVersion: string;
  milestoneContributors?: MilestoneContributor[]; milestoneId?: string; scenarioId?: string;
  milestoneImpact?: { activityId: string; targetDate?: string; calculatedFinish: string; scheduleDelta?: number };
}
export interface ActivityComparison {
  activityId: string; durationDelta: number; startDelta: number; finishDelta: number;
  slackDelta: number; riskDelta: number; criticalChanged: boolean; added?: boolean; removed?: boolean;
}
export interface ScenarioComparison {
  baseline: CalculationResults; scenario: CalculationResults; activities: ActivityComparison[];
  finishDelta: number; riskDelta: number; criticalDelta: number; negativeSlackDelta: number;
}
export const iso = (value: string | number | Date): string => {
  const date = new Date(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T09:00:00Z` : value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid date: ${String(value)}`);
  return date.toISOString();
};
export const defaultCalendar = (): Calendar => ({
  id: 'standard', name: 'Standard 8h / Monday-Friday (UTC)', workingDays: [1, 2, 3, 4, 5],
  workingIntervals: [{ start: '09:00', end: '17:00' }], holidays: [], exceptions: [],
});
export function createProject(name = 'Untitled Project'): ProjectModel {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    project: { id: crypto.randomUUID(), name, projectStart: iso(now.slice(0, 10)), defaultCalendarId: 'standard', createdAt: now, modifiedAt: now },
    activities: [], dependencies: [], calendars: [defaultCalendar()], scenarios: [], overrides: [], baselines: [],
    settings: { ...DEFAULT_RISK_SETTINGS },
  };
}
export function createActivity(projectId: string, index: number, milestone = false): Activity {
  return {
    id: crypto.randomUUID(), projectId, code: `${milestone ? 'MS' : 'ACT'}-${String(index).padStart(3, '0')}`,
    name: milestone ? 'New Milestone' : 'New Activity', type: milestone ? 'MILESTONE' : 'TASK',
    effortHours: 0, duration: milestone ? 0 : 1, durationUnit: 'd', elapsedMode: false,
    scheduleMode: 'AUTO', probabilityOfDelay: .3, delayP80: 2, status: 'NOT_STARTED',
    graphPosition: { x: (index % 4) * 330, y: Math.floor(index / 4) * 220 },
  };
}
export const snapshot = (m: ProjectSnapshot): ProjectSnapshot => structuredClone({
  project: m.project, activities: m.activities, dependencies: m.dependencies, calendars: m.calendars, settings: m.settings,
});
export { validateProject, parseProject } from './validation';
export { createDemo } from './demo';
