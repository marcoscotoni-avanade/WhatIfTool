import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { importJson } from '@planner/persistence';
import { scheduleProject } from '@planner/scheduling';
import { calculateProjectRisk } from '@planner/risk';

it('imports and calculates the complete JSON example in the Researcher instructions', () => {
  const text = readFileSync('docs/istruzioni-researcher-importazione.md', 'utf8');
  const example = text.split('## Esempio completo')[1]?.match(/```json\s*\n([\s\S]*?)\n```/)?.[1];
  expect(example).toBeDefined();
  const project = importJson(example!);
  const schedule = scheduleProject(project);
  const results = calculateProjectRisk(project, schedule, 'activity-go-live');
  expect(project.activities).toHaveLength(3);
  expect(project.dependencies).toHaveLength(2);
  expect(schedule.activities['activity-go-live']?.calculatedFinish).toBe('2026-03-06T17:00:00.000Z');
  expect(results.risk['activity-go-live']?.totalRisk).toBeGreaterThan(0);
});
