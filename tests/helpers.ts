import { createProject, createActivity, iso, type DependencyType, type ProjectModel } from '@planner/domain';
export function fixture(count = 2, type: DependencyType = 'FS', lag = 0): ProjectModel {
  const m = createProject('Test');
  m.project.projectStart = iso('2026-11-09');
  m.activities = Array.from({ length: count }, (_, i) => ({
    ...createActivity(m.project.id, i + 1), id: String(i), name: `Task ${i}`, duration: i === 0 ? 2 : 1,
  }));
  m.dependencies = Array.from({ length: count - 1 }, (_, i) => ({
    id: `e${i}`, projectId: m.project.id, predecessorId: String(i), successorId: String(i + 1), type, lag, lagUnit: 'd',
  }));
  return m;
}
