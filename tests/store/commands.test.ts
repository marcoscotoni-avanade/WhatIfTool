import { expect, it, beforeEach } from 'vitest';
import { fixture } from '../helpers';
import { useProjectStore as store } from '../../apps/desktop/src/store/useProjectStore';
import { toModel } from '../../apps/desktop/src/store/document';
import { resolveScenario } from '@planner/scenarios';
import { activityPatch } from '../../apps/desktop/src/store/editing';

beforeEach(() => store.getState().load(fixture()));
it('does not allow free-form tag edits through generic activity fields', () => {
  expect(() => activityPatch('tags', 'Critical', fixture().activities[0]!, '2026-11-09T09:00:00Z')).toThrow(/read-only/);
});
it('removes assignments when a tag is removed from the project catalog and supports undo', () => {
  const m = fixture();
  m.project.tagCatalog = ['Critical', 'Finance'];
  m.activities[0]!.tags = ['Critical', 'Finance'];
  store.getState().load(m);
  expect(store.getState().setTagCatalog(['Finance'])).toBe(true);
  expect(store.getState().document.project.tagCatalog).toEqual(['Finance']);
  expect(store.getState().document.activitiesById['0']!.tags).toEqual(['Finance']);
  store.getState().undo();
  expect(store.getState().document.project.tagCatalog).toEqual(['Critical', 'Finance']);
  expect(store.getState().document.activitiesById['0']!.tags).toEqual(['Critical', 'Finance']);
});
it('updates the project catalog and task tag assignments as scenario overrides', () => {
  const m = fixture();
  m.project.tagCatalog = ['Critical', 'Finance'];
  m.activities[0]!.tags = ['Critical'];
  store.getState().load(m);
  store.getState().newScenario('Tag changes');
  const scenarioId = store.getState().activeScenarioId!;
  expect(store.getState().setTagCatalog(['critical', 'Finance'])).toBe(true);
  const resolved = resolveScenario(toModel(store.getState().document), scenarioId);
  expect(resolved.project.tagCatalog).toEqual(['critical', 'Finance']);
  expect(resolved.activities[0]!.tags).toEqual(['critical']);
  expect(store.getState().document.activitiesById['0']!.tags).toEqual(['Critical']);
});
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
