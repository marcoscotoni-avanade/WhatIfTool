import { expect, it, beforeEach } from 'vitest';
import { fixture } from '../helpers';
import { useProjectStore as store } from '../../apps/desktop/src/store/useProjectStore';
import { toModel } from '../../apps/desktop/src/store/document';
import { resolveScenario } from '@planner/scenarios';

beforeEach(() => store.getState().load(fixture()));
it('undoes and redoes canonical changes and rejects invalid commands without history', () => {
  store.getState().updateActivities(['0'], { duration: 7 });
  expect(store.getState().document.activitiesById['0']!.duration).toBe(7);
  store.getState().undo();
  expect(store.getState().document.activitiesById['0']!.duration).toBe(2);
  store.getState().redo();
  expect(store.getState().document.activitiesById['0']!.duration).toBe(7);
  const before = store.getState().history.length;
  store.getState().connect('1', '0');
  expect(store.getState().error).toMatch(/cycle/);
  expect(store.getState().history.length).toBe(before);
});
it('writes only overrides for scenario edits and restores scenario on undo', () => {
  store.getState().newScenario('Delay');
  const id = store.getState().activeScenarioId;
  store.getState().updateActivities(['0'], { duration: 9 });
  const m = toModel(store.getState().document);
  expect(m.activities[0]!.duration).toBe(2);
  expect(resolveScenario(m, id).activities[0]!.duration).toBe(9);
  store.getState().undo();
  expect(resolveScenario(toModel(store.getState().document), id).activities[0]!.duration).toBe(2);
  store.getState().undo();
  expect(store.getState().activeScenarioId).toBeUndefined();
});
