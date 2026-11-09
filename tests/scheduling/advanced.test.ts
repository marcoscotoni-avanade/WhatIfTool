import { expect, it } from 'vitest';
import { createActivity, createDemo, iso, validateProject } from '@planner/domain';
import { addWorkingDuration, activityCalendar, nominalDayHours, scheduleProject, workingDurationBetween } from '@planner/scheduling';
import { analyzeMilestoneContributors, calculateProjectRisk, calculateRisk } from '@planner/risk';
import { createScenario, writeOverride, resolveScenario } from '@planner/scenarios';
import { fixture } from '../helpers';

it('preserves a finish-based bound at an opening after an overnight gap', () => {
  const m = fixture(2, 'FF', -1);
  m.activities[0]!.plannedStart = iso('2026-11-10'); m.activities[0]!.duration = 1;
  const r = scheduleProject(m).activities['1']!;
  expect(r.calculatedFinish).toBe(iso('2026-11-10'));
  expect(workingDurationBetween(r.calculatedStart, r.calculatedFinish, m.calendars[0]!)).toBe(1);
  expect(r.violations).toEqual([]);
});
it('propagates fixed manual dates backward, including upstream negative slack', () => {
  const m = fixture();
  m.project.targetFinish = iso('2026-11-30T17:00Z');
  m.activities[1]!.scheduleMode = 'MANUAL'; m.activities[1]!.plannedStart = iso('2026-11-09');
  const r = scheduleProject(m);
  expect(r.activities['0']!.totalSlack).toBe(-2);
  expect(r.activities['1']!.totalSlack).toBe(-2);
});
it('handles finish-only manual dates, actual dates and elapsed-hour durations', () => {
  const m = fixture(1);
  const a = m.activities[0]!;
  a.scheduleMode = 'MANUAL'; a.duration = 1; a.plannedFinish = iso('2026-11-10');
  expect(scheduleProject(m).activities['0']!.calculatedFinish).toBe(a.plannedFinish);
  a.actualStart = iso('2026-11-13T17:00Z'); a.plannedFinish = undefined;
  a.duration = 48; a.durationUnit = 'h'; a.elapsedMode = true;
  expect(scheduleProject(m).activities['0']!.calculatedFinish).toBe(iso('2026-11-15T17:00Z'));
});
it('keeps global latest dates on unrelated branches when focusing on a milestone', () => {
  const m = fixture(3);
  m.dependencies = [m.dependencies[0]!];
  m.activities[1]!.type = 'MILESTONE'; m.activities[1]!.duration = 0;
  m.activities[1]!.targetDate = iso('2026-11-09T17:00Z');
  const global = scheduleProject(m), focus = scheduleProject(m, { milestoneId: '1' });
  expect(focus.activities['2']).toEqual(global.activities['2']);
  expect(focus.activities['0']!.totalSlack).toBeLessThan(0);
});
it('uses the project deadline when a focused milestone has no separate target', () => {
  const m = fixture();
  m.activities[1]!.type = 'MILESTONE'; m.activities[1]!.duration = 0;
  m.project.targetFinish = iso('2026-11-13T17:00Z');
  const schedule = scheduleProject(m, { milestoneId: '1' });
  expect(schedule.activities['0']!.totalSlack).toBe(3);
  expect(calculateProjectRisk(m, schedule, '1').milestoneImpact).toEqual({
    activityId: '1', targetDate: m.project.targetFinish, calculatedFinish: iso('2026-11-10T17:00Z'), scheduleDelta: -3,
  });
});
it('supports arbitrary string IDs in result dictionaries', () => {
  const m = fixture(1);
  m.activities[0]!.id = '__proto__';
  const s = scheduleProject(m), risk = calculateRisk(m, s);
  expect(Object.keys(s.activities)).toEqual(['__proto__']);
  expect(Object.keys(risk)).toEqual(['__proto__']);
  expect(s.activities['__proto__']!.calculatedStart).toBe(iso('2026-11-09'));
});
it('supports per-activity calendars and hour lag across holidays', () => {
  const m = fixture(2, 'FS');
  m.calendars.push({ ...m.calendars[0]!, id: 'short', workingIntervals: [{ start: '10:00', end: '14:00' }], holidays: ['2026-11-11'] });
  m.activities[1]!.calendarId = 'short';
  m.dependencies[0]!.lag = 2; m.dependencies[0]!.lagUnit = 'h';
  const s = scheduleProject(m).activities['1']!;
  expect(s.calculatedStart).toBe(iso('2026-11-12T12:00Z'));
  expect(s.calculatedFinish).toBe(iso('2026-11-13T12:00Z'));
});
it.each([
  (m: ReturnType<typeof fixture>) => { m.activities[0]!.duration = -1; },
  (m: ReturnType<typeof fixture>) => { m.activities[0]!.effortHours = -1; },
  (m: ReturnType<typeof fixture>) => { m.activities[0]!.type = 'MILESTONE'; },
  (m: ReturnType<typeof fixture>) => { m.dependencies[0]!.lag = NaN; },
  (m: ReturnType<typeof fixture>) => { m.dependencies[0]!.successorId = 'missing'; },
  (m: ReturnType<typeof fixture>) => { m.activities[0]!.plannedStart = '2026-02-30'; },
  (m: ReturnType<typeof fixture>) => { m.activities[0]!.probabilityOfDelay = 2; },
  (m: ReturnType<typeof fixture>) => { m.settings.defaultImpactHorizon = 0; },
  (m: ReturnType<typeof fixture>) => { m.calendars[0]!.workingIntervals = [{ start: '17:00', end: '09:00' }]; },
])('rejects invalid planning data %#', mutate => {
  const m = fixture(); mutate(m); expect(() => validateProject(m)).toThrow();
});
it('optimized contributor counterfactuals match a full risk recomputation', () => {
  const m = createDemo(), schedule = scheduleProject(m), original = calculateRisk(m, schedule);
  const ranking = analyzeMilestoneContributors(m, schedule, 'activity-7');
  for (const c of ranking) expect(c.contribution).toBeCloseTo(original['activity-7']!.totalRisk - calculateRisk(m, schedule, c.activityId)['activity-7']!.totalRisk);
  expect(ranking[0]!.activityId).toBe('activity-2');
});
it('can delete a newly created scenario activity after field edits', () => {
  const { model: m, id } = createScenario(fixture(), 'Structural');
  const a = createActivity(m.project.id, 3);
  writeOverride(m, id, 'activity', a.id, '$entity', a);
  writeOverride(m, id, 'activity', a.id, 'duration', 3);
  writeOverride(m, id, 'activity', a.id, '$entity', null);
  expect(resolveScenario(m, id).activities.length).toBe(2);
});
it('satisfies forward dependency bounds on a mixed 200-node DAG', () => {
  const m = fixture(200);
  const types = ['FS', 'SS', 'FF', 'SF'] as const;
  m.activities.forEach((a, i) => { a.duration = i % 4 + .25; a.durationUnit = i % 3 === 0 ? 'h' : 'd'; });
  m.dependencies.forEach((d, i) => { d.type = types[i % 4]!; d.lag = i % 5 - 2; });
  const r = scheduleProject(m);
  for (const d of m.dependencies) {
    const p = r.activities[d.predecessorId]!, s = r.activities[d.successorId]!, a = m.activities.find(a => a.id === d.successorId)!;
    const bound = addWorkingDuration(d.type[0] === 'F' ? p.calculatedFinish : p.calculatedStart, d.lag, d.lagUnit, activityCalendar(m, a));
    expect(Date.parse(d.type[1] === 'F' ? s.calculatedFinish : s.calculatedStart)).toBeGreaterThanOrEqual(Date.parse(bound));
  }
  expect(Object.values(r.activities).every(a => a.violations.length === 0)).toBe(true);
});
it('calculates 1,000 activities and several thousand edges without changing architecture', () => {
  const m = fixture(1000);
  m.dependencies = [];
  m.activities.forEach((a, i) => {
    a.duration = .25; a.durationUnit = 'h'; a.intrinsicRisk = 65; a.probabilityOfDelay = .9; a.delayP80 = 5;
    for (let distance = 1; distance <= 3 && i + distance < 1000; distance++) m.dependencies.push({
      id: `${i}-${distance}`, projectId: m.project.id, predecessorId: String(i), successorId: String(i + distance), type: 'FS', lag: 0, lagUnit: 'd',
    });
  });
  const started = performance.now(), schedule = scheduleProject(m), risk = calculateRisk(m, schedule);
  const contributors = analyzeMilestoneContributors(m, schedule, '999');
  const elapsed = performance.now() - started;
  console.info(`[performance] 1000 nodes / ${m.dependencies.length} edges + 999 counterfactuals: ${elapsed.toFixed(0)}ms`);
  expect(Object.keys(schedule.activities).length).toBe(1000);
  expect(contributors.length).toBe(999);
  expect(Object.values(risk).every(r => r.totalRisk <= 100)).toBe(true);
  expect(elapsed).toBeLessThan(15_000);
  expect(nominalDayHours(m.calendars[0]!)).toBe(8);
}, 20_000);
