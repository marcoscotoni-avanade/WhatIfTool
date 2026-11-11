import { expect, it } from 'vitest';
import { createDemo } from '@planner/domain';
import { createScenario, manageBaseline, publishBaseline, resolveScenario } from '@planner/scenarios';
import { createProjectEngine, toModel } from '../../packages/application/src/index';

it('deletes unused baseline and its read-only scenario, with undo restoring both', () => {
  const engine = createProjectEngine();
  engine.getState().load(publishBaseline(createDemo(), 'Unused'));
  const baseline = engine.getState().document.baselines[0]!;
  const scenario = Object.values(engine.getState().document.scenariosById)[0]!;
  engine.getState().activateScenario(scenario.id);
  expect(engine.getState().manageBaseline(baseline.id, 'delete', 'Wrong')).toBe(false);
  expect(engine.getState().manageBaseline(baseline.id, 'delete', 'Unused')).toBe(true);
  expect(engine.getState().document.baselines).toHaveLength(0);
  expect(engine.getState().activeScenarioId).toBeUndefined();
  engine.getState().undo();
  expect(engine.getState().document.baselines).toHaveLength(1);
});
it('blocks deletion in use and archives without changing snapshots or resolving scenarios', () => {
  const { model, id } = createScenario(publishBaseline(createDemo(), 'Used'), 'What if');
  const baseline = model.baselines[0]!;
  expect(() => manageBaseline(model, baseline.id, 'delete')).toThrow(/used by scenarios/);
  const archived = manageBaseline(model, baseline.id, 'archive');
  expect(archived.baselines[0]!.snapshot).toEqual(baseline.snapshot);
  expect(resolveScenario(archived, id)).toEqual(resolveScenario(model, id));
  expect(manageBaseline(archived, baseline.id, 'restore').baselines[0]!.archived).toBe(false);
  const next = createScenario(archived, 'New');
  expect(next.model.scenarios.find(s => s.id === next.id)!.baselineVersionId).not.toBe(baseline.id);
  const engine = createProjectEngine();
  engine.getState().load(archived);
  expect(toModel(engine.getState().document).baselines[0]!.archived).toBe(true);
});
