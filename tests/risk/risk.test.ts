import { expect, it } from 'vitest';
import { scheduleProject } from '@planner/scheduling';
import { analyzeMilestoneContributors, calculateRisk, noisyOr } from '@planner/risk';
import { fixture } from '../helpers';

it('computes intrinsic from probability and delay, supports manual override', () => {
  const m = fixture(1);
  m.activities[0]!.probabilityOfDelay = .5; m.activities[0]!.delayP80 = 2;
  expect(calculateRisk(m, scheduleProject(m))['0']!.totalRisk).toBeCloseTo(20);
  m.activities[0]!.intrinsicRisk = 82;
  expect(calculateRisk(m, scheduleProject(m))['0']!.totalRisk).toBeCloseTo(82);
});
it('gates below threshold, transmits above it and explains exact factors', () => {
  const m = fixture();
  m.activities[0]!.intrinsicRisk = 49; m.activities[0]!.probabilityOfDelay = .8; m.activities[0]!.delayP80 = 4;
  expect(calculateRisk(m, scheduleProject(m))['1']!.propagatedRisk).toBe(0);
  m.activities[0]!.intrinsicRisk = 50;
  const c = calculateRisk(m, scheduleProject(m))['1']!.contributors[0]!;
  expect(c.availableSlack).toBe(0);
  expect(c.transmittedRisk).toBeCloseTo(.8 * .8 * .5 * (1 - Math.exp(-4 / 5)) * 100);
});
it('absorbs delay in large slack, increases exposure for negative slack', () => {
  const m = fixture();
  m.activities[0]!.intrinsicRisk = 90; m.activities[0]!.probabilityOfDelay = 1; m.activities[0]!.delayP80 = 3;
  const normal = calculateRisk(m, scheduleProject(m))['1']!.propagatedRisk;
  m.activities[1]!.plannedStart = '2026-11-25T09:00:00Z';
  expect(calculateRisk(m, scheduleProject(m))['1']!.propagatedRisk).toBe(0);
  m.activities[1]!.plannedStart = '2026-11-09T09:00:00Z'; m.activities[1]!.scheduleMode = 'MANUAL';
  const r = calculateRisk(m, scheduleProject(m))['1']!;
  expect(r.propagatedRisk).toBeGreaterThan(normal);
  expect(r.conflictRisk).toBeGreaterThan(0);
});
it('uses noisy-OR, caps risk, damps multi-hop transmission', () => {
  expect(noisyOr([.5, .5])).toBe(.75);
  const m = fixture(30);
  m.activities.forEach(a => { a.intrinsicRisk = 60; a.probabilityOfDelay = 1; a.delayP80 = 100; });
  m.settings.transmissionCap = .3;
  const r = calculateRisk(m, scheduleProject(m));
  expect(Object.values(r).every(v => v.totalRisk <= 100 && v.totalRisk >= 0)).toBe(true);
  expect(r['1']!.contributors[0]!.transmittedRisk).toBeLessThanOrEqual(30);
  m.activities.slice(1).forEach(a => { a.intrinsicRisk = 0; });
  const damped = calculateRisk(m, scheduleProject(m));
  expect(damped['2']!.totalRisk).toBe(0);
});
it('combines multiple predecessors and ranks each ancestor once', () => {
  const m = fixture(4);
  m.dependencies = [
    { ...m.dependencies[0]!, id: 'a', predecessorId: '0', successorId: '1' },
    { ...m.dependencies[0]!, id: 'b', predecessorId: '0', successorId: '2' },
    { ...m.dependencies[0]!, id: 'c', predecessorId: '1', successorId: '3' },
    { ...m.dependencies[0]!, id: 'd', predecessorId: '2', successorId: '3' },
  ];
  m.activities.forEach(a => { a.intrinsicRisk = 90; a.probabilityOfDelay = 1; a.delayP80 = 20; });
  const s = scheduleProject(m), risk = calculateRisk(m, s);
  const c = risk['3']!.contributors;
  expect(risk['3']!.propagatedRisk).toBeCloseTo(noisyOr(c.map(x => x.transmittedRisk / 100)) * 100);
  const ranking = analyzeMilestoneContributors(m, s, '3');
  expect(new Set(ranking.map(x => x.activityId)).size).toBe(3);
  expect(ranking[0]!.contribution).toBeGreaterThanOrEqual(ranking[1]!.contribution);
});
