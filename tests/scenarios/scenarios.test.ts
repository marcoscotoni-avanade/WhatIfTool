import { expect, it } from 'vitest';
import { calculateComparison, createScenario, publishBaseline, resolveScenario, validateDocument, writeOverride } from '@planner/scenarios';
import { fixture } from '../helpers';

it('resolves baseline and inherited field overrides without mutating baseline', () => {
  const published = publishBaseline(fixture(), 'v1'), before = structuredClone(published.baselines);
  const { model: m, id } = createScenario(published, 'Delay');
  writeOverride(m, id, 'activity', '0', 'duration', 5);
  const { model: child, id: cid } = createScenario(m, 'Child', id);
  writeOverride(child, cid, 'activity', '1', 'intrinsicRisk', 90);
  expect(resolveScenario(child, cid).activities[0]!.duration).toBe(5);
  expect(resolveScenario(child, cid).activities[1]!.intrinsicRisk).toBe(90);
  expect(child.baselines).toEqual(before);
  expect(() => writeOverride(child, child.scenarios[0]!.id, 'activity', '0', 'duration', 7)).toThrow(/immutable/);
  expect(calculateComparison(child, cid).finishDelta).toBe(3);
});
it('rejects invalid overrides, inheritance cycles and calculated field edits', () => {
  const { model: m, id } = createScenario(fixture(), 'Test');
  writeOverride(m, id, 'activity', '0', 'calculatedStart', '2026-01-01');
  expect(() => resolveScenario(m, id)).toThrow(/not editable/);
  m.overrides = []; m.scenarios.find(s => s.id === id)!.parentScenarioId = id;
  expect(() => validateDocument(m)).toThrow(/cycle/i);
});
it('supports structural overrides and preserves historical versions on promote', () => {
  const { model: m, id } = createScenario(fixture(), 'Delete branch');
  writeOverride(m, id, 'dependency', 'e0', '$entity', null);
  writeOverride(m, id, 'activity', '1', '$entity', null);
  expect(resolveScenario(m, id).activities.length).toBe(1);
  const promoted = publishBaseline(m, 'v2', id);
  expect(promoted.baselines.length).toBe(2);
  expect(promoted.baselines[0]!.snapshot.activities.length).toBe(2);
});
