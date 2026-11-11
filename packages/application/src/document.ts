import type { Activity, Dependency, ProjectModel, Scenario } from '@planner/domain';

export interface DocumentState extends Omit<ProjectModel, 'activities' | 'dependencies' | 'scenarios'> {
  activitiesById: Record<string, Activity>; dependenciesById: Record<string, Dependency>; scenariosById: Record<string, Scenario>;
}
export function normalize(m: ProjectModel): DocumentState {
  const { activities, dependencies, scenarios, ...rest } = m;
  return { ...rest, activitiesById: Object.fromEntries(activities.map(a => [a.id, a])),
    dependenciesById: Object.fromEntries(dependencies.map(d => [d.id, d])), scenariosById: Object.fromEntries(scenarios.map(s => [s.id, s])) };
}
export function toModel(d: DocumentState): ProjectModel {
  const { activitiesById, dependenciesById, scenariosById, ...rest } = d;
  return { ...rest, activities: Object.values(activitiesById), dependencies: Object.values(dependenciesById), scenarios: Object.values(scenariosById) };
}
export interface DocumentCommand {
  name: string; execute(): DocumentState; undo(): DocumentState; redo(): DocumentState;
  beforeScenarioId?: string; afterScenarioId?: string;
}
export function command(name: string, before: DocumentState, after: DocumentState, beforeScenarioId?: string, afterScenarioId?: string): DocumentCommand {
  return { name, execute: () => after, undo: () => before, redo: () => after, beforeScenarioId, afterScenarioId };
}
