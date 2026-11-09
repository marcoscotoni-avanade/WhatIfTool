import { expect, it } from 'vitest';
import { createDemo, type ProjectModel } from '@planner/domain';
import { SqliteProjectRepository, type BinaryStore } from '@planner/persistence';
import { createScenario, writeOverride } from '@planner/scenarios';
import { importCsv, importJson, toCsv, exportJson } from '../../packages/persistence/src/exchange';
import { resolve } from 'node:path';

it('round trips a real SQLite file with baselines, overrides, graph positions, settings and exceptions', async () => {
  const map = new Map<string, Uint8Array>();
  const store: BinaryStore = { read: async id => map.get(id), write: async (id, b) => { map.set(id, b); },
    remove: async id => { map.delete(id); }, keys: async () => [...map.keys()] };
  const repo = await SqliteProjectRepository.create(store, () => resolve('node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'));
  const { model: m, id } = createScenario(createDemo(), 'Supplier Delay');
  writeOverride(m, id, 'activity', 'activity-2', 'duration', 18);
  m.calendars[0]!.exceptions.push({ date: '2026-11-14', intervals: [] });
  m.settings.defaultDamping = .7;
  await repo.saveProject(m);
  expect(new TextDecoder().decode(map.get(m.project.id)!.slice(0, 15))).toBe('SQLite format 3');
  const reopened = await repo.loadProject(m.project.id);
  expect(reopened).toEqual(JSON.parse(JSON.stringify(m)));
  expect((await repo.listProjects())[0]!.name).toBe('ERP Go Live');
  expect((await repo.loadScenario(m.project.id, id)).name).toBe('Supplier Delay');
  expect(() => repo.decode(new Uint8Array([0, 1, 2]))).toThrow();
  await repo.deleteProject(m.project.id);
  expect(await repo.listProjects()).toEqual([]);
});
it('round trips JSON and quoted multiline CSV and validates imports atomically', () => {
  const m = createDemo();
  m.activities[0]!.name = 'Design, "review"\nSignoff';
  expect(importJson(exportJson(m))).toEqual(m);
  expect(importCsv(m, toCsv(m.activities), 'activities').activities).toEqual(m.activities);
  expect(importCsv(m, toCsv(m.dependencies), 'dependencies').dependencies).toEqual(m.dependencies);
  expect(() => importJson('{"schemaVersion":2}')).toThrow();
  expect(() => importCsv(m, 'name,duration\nBad,-4', 'activities')).toThrow();
  expect(() => importJson(JSON.stringify({ ...m, activities: [{ ...m.activities[0]!, duration: -1 }] } satisfies Partial<ProjectModel>))).toThrow();
});
it('preserves team and owner in SQLite, JSON, CSV and baseline snapshots', async () => {
  const map = new Map<string, Uint8Array>();
  const storage: BinaryStore = { read: async id => map.get(id), write: async (id, bytes) => { map.set(id, bytes); },
    remove: async id => { map.delete(id); }, keys: async () => [...map.keys()] };
  const repo = await SqliteProjectRepository.create(storage, () => resolve('node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'));
  const m = createDemo();
  m.project.team = { name: 'Team', calendarId: 'standard', members: [{ id: 'm', name: 'Marco', allocationPercent: 50 }] };
  m.activities[0]!.ownerId = 'm';
  const withBaseline = createScenario(m, 'Scenario').model;
  expect(importJson(exportJson(withBaseline))).toEqual(withBaseline);
  expect(importCsv(m, toCsv(m.activities), 'activities').activities[0]!.ownerId).toBe('m');
  await repo.saveProject(withBaseline);
  expect(await repo.loadProject(m.project.id)).toEqual(JSON.parse(JSON.stringify(withBaseline)));
  expect(repo.decode(repo.encode(createDemo())).project.team).toBeUndefined();
});
