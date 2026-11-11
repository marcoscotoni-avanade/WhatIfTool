import { expect, it } from 'vitest';
import { createProjectEngine, normalize, toModel } from '../../packages/application/src/index';
import { fixture } from '../helpers';

it('creates independent vanilla engines with reusable normalized documents', () => {
  const model = fixture(), first = createProjectEngine(model), second = createProjectEngine(model);
  first.getState().updateActivities([model.activities[0]!.id], { name: 'Changed' });
  expect(toModel(first.getState().document).activities[0]!.name).toBe('Changed');
  expect(toModel(second.getState().document)).toEqual(model);
  expect(toModel(normalize(model))).toEqual(model);
  first.getState().undo();
  expect(toModel(first.getState().document)).toEqual(model);
});

it('keeps duration proposals atomic and prevents undo from invalidating an open proposal', () => {
  const model = fixture(), engine = createProjectEngine(model), id = model.activities[0]!.id;
  engine.getState().updateActivities([id], { name: 'Before proposal' });
  engine.getState().updateActivities([id], { effortHours: 40 });
  expect(engine.getState().pendingEdit?.proposals).toHaveLength(1);
  engine.getState().undo();
  expect(toModel(engine.getState().document).activities[0]!.name).toBe('Before proposal');
  engine.getState().finishEdit([id]);
  expect(engine.getState().pendingEdit).toBeUndefined();
  expect(toModel(engine.getState().document).activities[0]!.effortHours).toBe(40);
  engine.getState().undo();
  expect(toModel(engine.getState().document).activities[0]!.effortHours).toBe(model.activities[0]!.effortHours);
});
