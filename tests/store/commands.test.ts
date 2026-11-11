import { expect, it, beforeEach } from 'vitest';
import { fixture } from '../helpers';
import { useProjectStore as store } from '../../apps/desktop/src/store/useProjectStore';
import { toModel } from '../../apps/desktop/src/store/document';
import { resolveScenario } from '@planner/scenarios';
import { activityPatch } from '../../apps/desktop/src/store/editing';

beforeEach(() => store.getState().load(fixture()));
it('pastes mixed updates and new activities atomically with undo and redo', () => {
  const before = toModel(store.getState().document);
  const code = before.activities[0]!.code;
  expect(store.getState().pasteActivities([
    { code, name: 'Updated' }, { code: 'NEW-1', name: 'New task', duration: '3' },
    { code: 'NEW-MS', name: 'New milestone', type: 'MILESTONE' },
  ])).toBe(true);
  const model = toModel(store.getState().document);
  expect(model.activities.find(a => a.code === code)!.name).toBe('Updated');
  expect(model.activities.find(a => a.code === 'NEW-1')).toMatchObject({ name: 'New task', duration: 3, type: 'TASK', durationUnit: 'd', elapsedMode: false });
  expect(model.activities.find(a => a.code === 'NEW-MS')).toMatchObject({ type: 'MILESTONE', duration: 0 });
  expect(store.getState().history).toHaveLength(1);
  store.getState().undo();
  expect(toModel(store.getState().document).activities).toEqual(before.activities);
  store.getState().redo();
  expect(toModel(store.getState().document).activities).toEqual(model.activities);
});
it('rejects invalid paste rows without applying any updates or inserts', () => {
  const before = toModel(store.getState().document);
  const invalidRecords: Record<string, string>[] = [
    { code: 'NEW', name: '' }, { code: '', name: 'Missing code' },
    { code: 'NEW', name: 'Invalid', duration: '-1' },
    { code: 'NEW', name: 'Invalid', ownerId: 'missing' },
  ];
  for (const invalid of invalidRecords) {
    expect(store.getState().pasteActivities([{ code: before.activities[0]!.code, name: 'Must not change' }, invalid])).toBe(false);
    expect(toModel(store.getState().document)).toEqual(before);
  }
  expect(store.getState().pasteActivities([{ code: 'NEW', name: 'One' }, { code: 'NEW', name: 'Two' }])).toBe(false);
  expect(store.getState().history).toHaveLength(0);
});
it('pastes new activities into a scenario without modifying the baseline', () => {
  store.getState().newScenario('Paste scenario');
  const before = toModel(store.getState().document);
  expect(store.getState().pasteActivities([{ code: 'SCENARIO-NEW', name: 'Scenario task' }])).toBe(true);
  const after = toModel(store.getState().document);
  expect(after.activities).toEqual(before.activities);
  expect(resolveScenario(after, store.getState().activeScenarioId).activities.find(a => a.code === 'SCENARIO-NEW')).toBeDefined();
  store.getState().undo();
  expect(resolveScenario(toModel(store.getState().document), store.getState().activeScenarioId).activities.find(a => a.code === 'SCENARIO-NEW')).toBeUndefined();
});
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
