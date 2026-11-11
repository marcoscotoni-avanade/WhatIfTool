import { expect, it } from 'vitest';
import { createDemo, type ProjectModel } from '@planner/domain';
import { SqliteProjectRepository, type BinaryStore } from '@planner/persistence';
import { createScenario, writeOverride } from '@planner/scenarios';
import { importCsv, importJson, parseCsv, toCsv, exportJson } from '../../packages/persistence/src/exchange';
import { resolve } from 'node:path';

it('exports UTF-8 CSV with a BOM and preserves Unicode through reimport', () => {
  const m = createDemo();
  m.activities[0]!.name = 'Qualit\u00e0, caff\u00e8 \u2013 \u201cverifica\u201d \u20ac';
  m.activities[0]!.description = '\u00c8 gi\u00e0 pronto\n\u6d4b\u8bd5';
  const csv = toCsv(m.activities);
  const bytes = new TextEncoder().encode(csv);
  expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  for (const text of [csv, new TextDecoder().decode(bytes)]) {
    expect(importCsv(m, text, 'activities').activities[0]).toMatchObject({
      name: m.activities[0]!.name, description: m.activities[0]!.description,
    });
  }
  expect(parseCsv(toCsv([{ code: 'A', name: '\u00e0' }]))).toEqual([{ code: 'A', name: '\u00e0' }]);
});

it('parses spreadsheet TSV with quoted multiline values and trailing empty cells', () => {
  expect(parseCsv('code\tdescription\townerId\r\nMIG\t"Review ""SCM""\tsetup\r\nSignoff"\t\r\n', '\t')).toEqual([
    { code: 'MIG', description: 'Review "SCM"\tsetup\r\nSignoff', ownerId: '' },
  ]);
  expect(parseCsv('code\townerId\nMIG\t', '\t')).toEqual([{ code: 'MIG', ownerId: '' }]);
  expect(() => parseCsv('code\tcode\nMIG\tMIG', '\t')).toThrow(/headers/);
  expect(() => parseCsv('code\tname\nMIG', '\t')).toThrow(/columns/);
  expect(() => parseCsv('code\tname\nMIG\t"Unclosed', '\t')).toThrow(/Unclosed quote/);
});

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
  m.activities[0]!.tags = ['Critical', 'Finance'];
  m.project.tagCatalog = ['Critical', 'Finance'];
  expect(importJson(exportJson(m))).toEqual(m);
  expect(importCsv(m, toCsv(m.activities), 'activities').activities).toEqual(m.activities);
  expect(importCsv(m, toCsv(m.activities), 'activities').project.tagCatalog).toEqual(['Critical', 'Finance']);
  expect(importCsv(m, toCsv(m.dependencies), 'dependencies').dependencies).toEqual(m.dependencies);
  const legacy = JSON.parse(exportJson(m)) as ProjectModel;
  delete legacy.project.tagCatalog;
  expect(importJson(JSON.stringify(legacy)).project.tagCatalog).toEqual(['Critical', 'Finance']);
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
  m.project.tagCatalog = ['Critical', 'Finance'];
  m.activities[0]!.ownerId = 'm';
  m.activities[0]!.tags = ['Critical', 'Finance'];
  const withBaseline = createScenario(m, 'Scenario').model;
  expect(importJson(exportJson(withBaseline))).toEqual(withBaseline);
  expect(importCsv(m, toCsv(m.activities), 'activities').activities[0]!.ownerId).toBe('m');
  expect(importCsv(m, toCsv(m.activities), 'activities').activities[0]!.tags).toEqual(['Critical', 'Finance']);
  await repo.saveProject(withBaseline);
  expect(await repo.loadProject(m.project.id)).toEqual(JSON.parse(JSON.stringify(withBaseline)));
  expect(repo.decode(repo.encode(createDemo())).project.team).toBeUndefined();
});
