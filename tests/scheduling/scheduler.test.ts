import { describe, expect, it } from 'vitest';
import { defaultCalendar, iso, type DependencyType } from '@planner/domain';
import { scheduleProject, addWorkingDuration, subtractWorkingDuration, workingDurationBetween, getAncestors, getDescendants, type ScheduleCache } from '@planner/scheduling';
import { fixture } from '../helpers';

describe('calendar arithmetic', () => {
  it('skips weekends and holidays and preserves exact closing boundaries', () => {
    const c = defaultCalendar();
    c.holidays = ['2026-11-16'];
    expect(addWorkingDuration(iso('2026-11-13'), 2, 'd', c)).toBe(iso('2026-11-17T17:00Z'));
    expect(subtractWorkingDuration(iso('2026-11-17T17:00Z'), 2, 'd', c)).toBe(iso('2026-11-13'));
    expect(workingDurationBetween(iso('2026-11-13'), iso('2026-11-17T17:00Z'), c)).toBe(2);
  });
  it('handles elapsed, exceptions, negative lag and split intervals', () => {
    const c = defaultCalendar();
    c.exceptions = [{ date: '2026-11-14', intervals: [{ start: '10:00', end: '14:00' }] }];
    expect(addWorkingDuration(iso('2026-11-13'), 12, 'h', c)).toBe(iso('2026-11-14T14:00Z'));
    expect(addWorkingDuration(iso('2026-11-13'), 2, 'd', c, true)).toBe(iso('2026-11-15'));
    expect(addWorkingDuration(iso('2026-11-16'), -1, 'd', c)).toBe(iso('2026-11-13T13:00Z'));
    c.workingIntervals = [{ start: '09:00', end: '12:00' }, { start: '13:00', end: '18:00' }];
    expect(addWorkingDuration(iso('2026-11-09T11:00Z'), 3, 'h', c)).toBe(iso('2026-11-09T15:00Z'));
  });
});
describe('scheduler', () => {
  it.each<[DependencyType, string]>([['FS', '2026-11-11'], ['SS', '2026-11-09'], ['FF', '2026-11-10'], ['SF', '2026-11-09']])('%s forward constraint', (type, expected) => {
    expect(scheduleProject(fixture(2, type)).activities['1']!.calculatedStart).toBe(iso(expected));
  });
  it.each([[2, '2026-11-13'], [-1, '2026-11-10']])('supports lag %s', (lag, expected) => {
    expect(scheduleProject(fixture(2, 'FS', Number(lag))).activities['1']!.calculatedStart).toBe(iso(String(expected)));
  });
  it('supports diamond paths, milestones and critical/noncritical branches', () => {
    const m = fixture(4);
    m.activities[2]!.duration = 5;
    m.activities[3]!.type = 'MILESTONE'; m.activities[3]!.duration = 0;
    m.dependencies = [
      { ...m.dependencies[0]!, id: 'ab', predecessorId: '0', successorId: '1' },
      { ...m.dependencies[0]!, id: 'ac', predecessorId: '0', successorId: '2' },
      { ...m.dependencies[0]!, id: 'bd', predecessorId: '1', successorId: '3' },
      { ...m.dependencies[0]!, id: 'cd', predecessorId: '2', successorId: '3' },
    ];
    const r = scheduleProject(m);
    expect(r.activities['3']!.calculatedFinish).toBe(iso('2026-11-17T17:00Z'));
    expect(r.activities['1']!.totalSlack).toBe(4);
    expect(r.activities['2']!.critical).toBe(true);
    expect(getAncestors('3', m.dependencies).size).toBe(3);
    expect(getDescendants('0', m.dependencies).size).toBe(3);
  });
  it('preserves manual dates, reports violations, escalates negative slack', () => {
    const m = fixture();
    m.activities[1]!.scheduleMode = 'MANUAL'; m.activities[1]!.plannedStart = iso('2026-11-09');
    const r = scheduleProject(m);
    expect(r.activities['1']!.calculatedStart).toBe(iso('2026-11-09'));
    expect(r.activities['1']!.violations[0]!.type).toBe('DEPENDENCY');
    expect(r.activities['1']!.totalSlack).toBeLessThan(0);
  });
  it('applies constraints and deadlines without changing source', () => {
    const m = fixture();
    m.activities[1]!.constraintType = 'MUST_START_ON'; m.activities[1]!.constraintDate = iso('2026-11-09');
    const original = structuredClone(m);
    const r = scheduleProject(m);
    expect(r.activities['1']!.calculatedStart).toBe(iso('2026-11-09'));
    expect(r.activities['1']!.violations.length).toBeGreaterThan(0);
    expect(m).toEqual(original);
    m.activities[1]!.constraintType = 'FINISH_NO_LATER_THAN';
    const deadline = scheduleProject(m);
    expect(deadline.activities['0']!.totalSlack).toBeLessThan(0);
  });
  it('handles SNET, must-finish and project deadlines', () => {
    const m = fixture();
    m.activities[1]!.constraintType = 'START_NO_EARLIER_THAN'; m.activities[1]!.constraintDate = iso('2026-11-13');
    expect(scheduleProject(m).activities['1']!.calculatedStart).toBe(iso('2026-11-13'));
    m.activities[1]!.constraintType = 'MUST_FINISH_ON';
    expect(scheduleProject(m).activities['1']!.calculatedFinish).toBe(iso('2026-11-13'));
    m.project.targetFinish = iso('2026-11-10T17:00Z');
    expect(scheduleProject(m).activities['0']!.totalSlack).toBeLessThan(0);
  });
  it.each<DependencyType>(['FS', 'SS', 'FF', 'SF'])('%s backward pass satisfies bounds', type => {
    const m = fixture(2, type, 1);
    m.project.targetFinish = iso('2026-11-20T17:00Z');
    const r = scheduleProject(m), p = r.activities['0']!, s = r.activities['1']!;
    const anchorP = type[0] === 'F' ? p.lateFinish : p.lateStart;
    const anchorS = type[1] === 'F' ? s.lateFinish : s.lateStart;
    expect(workingDurationBetween(anchorP, anchorS, m.calendars[0]!)).toBeGreaterThanOrEqual(1 - 1e-8);
  });
  it('rejects cycles, self links and duplicates', () => {
    const m = fixture();
    m.dependencies.push({ ...m.dependencies[0]!, id: 'cycle', predecessorId: '1', successorId: '0' });
    expect(() => scheduleProject(m)).toThrow(/cycle/);
    m.dependencies[1]!.predecessorId = '0';
    expect(() => scheduleProject(m)).toThrow(/Self/);
    m.dependencies[1]!.successorId = '1';
    expect(() => scheduleProject(m)).toThrow(/Duplicate/);
  });
  it('reuses unchanged branches but propagates invalidation to descendants', () => {
    const m = fixture(4);
    m.dependencies = m.dependencies.slice(0, 2);
    const cache: ScheduleCache = new Map();
    scheduleProject(m, { cache });
    expect(scheduleProject(m, { cache }).recalculatedIds).toEqual([]);
    m.activities[1]!.duration = 4;
    expect(scheduleProject(m, { cache }).recalculatedIds).toEqual(['1', '2']);
  });
});
