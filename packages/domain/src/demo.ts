import { createActivity, createProject, iso, type ProjectModel } from './index';

export function createDemo(): ProjectModel {
  const m = createProject('ERP Go Live');
  m.project.projectStart = iso('2026-11-09');
  m.project.description = 'Explore migration exposure, protect Go Live, and compare a supplier-delay scenario.';
  m.project.targetFinish = iso('2026-12-09T17:00:00Z');
  const names = ['Solution Design', 'Development', 'Data Migration', 'Integration', 'Testing', 'UAT', 'Training', 'GO LIVE'];
  const durations = [3, 8, 12, 4, 5, 3, 4, 0];
  const positions = [[0, 100], [340, 0], [340, 260], [680, 0], [1020, 130], [1360, 130], [1020, 400], [1700, 230]];
  const plannedFinishes = ['2026-11-11', '2026-11-23', '2026-11-27', '2026-11-27', '2026-12-04', '2026-12-09', '2026-11-12', '2026-12-09'];
  m.activities = names.map((name, i) => ({
    ...createActivity(m.project.id, i + 1, i === 7), id: `activity-${i}`, code: ['DES', 'DEV', 'MIG', 'INT', 'TST', 'UAT', 'TRN', 'LIVE'][i]!,
    name, duration: durations[i]!, effortHours: durations[i]! * 6,
    plannedFinish: iso(`${plannedFinishes[i]}T17:00:00Z`),
    intrinsicRisk: i === 2 ? 92 : i === 3 ? 35 : i === 7 ? 8 : 25,
    probabilityOfDelay: i === 2 ? .95 : i === 7 ? .3 : 1, delayP80: i === 2 ? 9 : i === 4 || i === 5 ? 20 : 5,
    targetDate: i === 7 ? m.project.targetFinish : undefined,
    graphPosition: { x: positions[i]![0]!, y: positions[i]![1]! },
  }));
  m.dependencies = [[0, 1], [0, 2], [1, 3], [2, 4], [3, 4], [4, 5], [5, 7], [6, 7]].map(([p, s], i) => ({
    id: `edge-${i}`, projectId: m.project.id, predecessorId: `activity-${p}`, successorId: `activity-${s}`,
    type: 'FS', lag: 0, lagUnit: 'd',
  }));
  return m;
}
