import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDemo, type ProjectModel } from '@planner/domain';
import { publishBaseline, resolveScenario } from '@planner/scenarios';
import { createPlannerServer } from '../../apps/planner-service/src/server';
import { FileProjectRepository } from '../../apps/planner-service/src/repository';

let app: Awaited<ReturnType<typeof createPlannerServer>>, directory: string, url: string;
const uiToken = randomUUID(), agentToken = randomUUID();
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'whatif-service-test-'));
  app = await createPlannerServer({ directory, uiToken, agentToken, port: 0 });
  url = `http://127.0.0.1:${await app.listen()}`;
});
afterEach(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
async function call(path: string, payload?: unknown, actor: 'ui' | 'agent' = 'ui') {
  const response = await fetch(url + path, { method: payload === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${actor === 'ui' ? uiToken : agentToken}`, 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload) });
  return { status: response.status, data: await response.json() };
}
async function register(model = createDemo()) {
  const result = await call('/api/projects', { model, operationId: randomUUID() });
  expect(result.status).toBe(200);
  return { id: model.project.id, model, route: `/api/projects/${model.project.id}` };
}
it('persists commands before acknowledgement and rejects stale revisions and reused operation IDs', async () => {
  const { route, id } = await register();
  const command = { expectedRevision: 0, operationId: randomUUID(), action: 'pasteActivities', args: [[{ code: 'NEW', name: 'Persisted task' }]] };
  const changed = await call(route + '/commands', command);
  expect(changed.status).toBe(200);
  expect(changed.data.revision).toBe(1);
  const disk = await new FileProjectRepository(directory).read(id);
  expect(disk!.model.activities.some(a => a.code === 'NEW')).toBe(true);
  const replay = await call(route + '/commands', command);
  expect(replay.data.replayed).toBe(true);
  expect((await call(route)).data.model.activities.filter((a: { code: string }) => a.code === 'NEW')).toHaveLength(1);
  expect((await call(route + '/commands', { ...command, args: [[{ code: 'OTHER', name: 'Other' }]] })).status).toBe(409);
  expect((await call(route + '/commands', { ...command, operationId: randomUUID() })).status).toBe(409);
  const reopened = await createPlannerServer({ directory, uiToken, agentToken, port: 0 });
  expect((await reopened.service.get(id)).revision).toBe(1);
  expect((await reopened.service.get(id)).history).toHaveLength(1);
});
it('requires approval for agent draft writes and prevents agent self approval', async () => {
  const { route } = await register();
  const requested = await call(route + '/commands', { expectedRevision: 0, operationId: randomUUID(),
    action: 'pasteActivities', args: [[{ code: 'AGENT', name: 'Approved task' }]] }, 'agent');
  expect(requested.data.status).toBe('approval_required');
  expect((await call(route)).data.model.activities.some((a: { code: string }) => a.code === 'AGENT')).toBe(false);
  const decision = route + `/operations/${requested.data.operation.id}/decision`;
  expect((await call(decision, { approve: true }, 'agent')).status).toBe(403);
  const approved = await call(decision, { approve: true });
  expect(approved.data.operation.status).toBe('approved');
  expect(approved.data.model.activities.some((a: { code: string }) => a.code === 'AGENT')).toBe(true);
  expect((await call(decision, { approve: true })).status).toBe(409);
});
it('requires approval to delete unused baselines, preserving immutable snapshot checks', async () => {
  const model = publishBaseline(createDemo(), 'Unused');
  const { route } = await register(model);
  const pending = await call(route + '/commands', { expectedRevision: 0, operationId: randomUUID(),
    action: 'manageBaseline', args: [model.baselines[0]!.id, 'delete', 'Unused'] }, 'agent');
  expect(pending.data.status).toBe('approval_required');
  expect((await call(route)).data.model.baselines).toHaveLength(1);
  const accepted = await call(route + `/operations/${pending.data.operation.id}/decision`, { approve: true });
  expect(accepted.status).toBe(200);
  expect(accepted.data.model.baselines).toHaveLength(0);
  expect(accepted.data.model.scenarios).toHaveLength(0);
});
it('allows exactly one concurrent revisioned write and preserves a shared undo timeline', async () => {
  const { route } = await register();
  const commands = ['ONE', 'TWO'].map(code => call(route + '/commands', {
    expectedRevision: 0, operationId: randomUUID(), action: 'pasteActivities', args: [[{ code, name: code }]],
  }));
  const results = await Promise.all(commands);
  expect(results.map(result => result.status).sort()).toEqual([200, 409]);
  const current = (await call(route)).data;
  expect(current.revision).toBe(1);
  const undone = await call(route + '/commands', { expectedRevision: 1, operationId: randomUUID(), action: 'undo', args: [] });
  expect(undone.data.model.activities).toHaveLength(8);
  expect(undone.data.canRedo).toBe(true);
  const redone = await call(route + '/commands', { expectedRevision: 2, operationId: randomUUID(), action: 'redo', args: [] });
  expect(redone.data.model.activities).toHaveLength(9);
  expect(redone.data.revision).toBe(3);
});
it('requires approval when creating the first baseline and rejects edits to a published baseline', async () => {
  const { route } = await register();
  const pending = await call(route + '/commands', { expectedRevision: 0, operationId: randomUUID(), action: 'newScenario', args: ['First scenario'] }, 'agent');
  expect(pending.data.status).toBe('approval_required');
  expect((await call(route)).data.model.baselines).toHaveLength(0);
  const approved = await call(route + `/operations/${pending.data.operation.id}/decision`, { approve: true });
  const baselineId = approved.data.model.scenarios.find((scenario: { isBaseline: boolean }) => scenario.isBaseline).id;
  const attempted = await call(route + '/commands', {
    expectedRevision: 1, operationId: randomUUID(), action: 'addActivity', args: [], scenarioId: baselineId,
  });
  expect(attempted.status).toBe(403);
  expect((await call(route)).data.model.baselines).toHaveLength(1);
});
it('delivers revision events to authenticated clients', async () => {
  const { route } = await register();
  const controller = new AbortController();
  const response = await fetch(url + route + '/events', { headers: { Authorization: `Bearer ${uiToken}` }, signal: controller.signal });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toContain('"revision":0');
  await call(route + '/commands', { expectedRevision: 0, operationId: randomUUID(), action: 'addActivity', args: [] });
  const changed = await reader.read();
  expect(new TextDecoder().decode(changed.value)).toContain('"revision":1');
  await reader.cancel(); controller.abort();
});
it('invalidates approvals when project changes and preserves atomic validation', async () => {
  const { route } = await register();
  const operation = { expectedRevision: 0, operationId: randomUUID(), action: 'pasteActivities', args: [[{ code: 'AGENT', name: 'Task' }]] };
  const pending = await call(route + '/commands', operation, 'agent');
  expect((await call(route + '/commands', { ...operation, operationId: randomUUID(), args: [[{ code: 'UI', name: 'User task' }]] })).status).toBe(200);
  const decided = await call(route + `/operations/${pending.data.operation.id}/decision`, { approve: true });
  expect(decided.data.operation.status).toBe('conflict');
  const invalid = await call(route + '/commands', { expectedRevision: 1, operationId: randomUUID(), action: 'pasteActivities',
    args: [[{ code: 'VALID', name: 'Must not apply' }, { code: 'INVALID', name: 'Invalid', duration: '-1' }]] });
  expect(invalid.status).toBe(422);
  expect((await call(route)).data.model.activities.some((a: { code: string }) => a.code === 'VALID')).toBe(false);
});
it('isolates scenario writes and calculates using the same engines in a worker', async () => {
  const model = publishBaseline(createDemo(), 'Published');
  const { route } = await register(model);
  const scenario = await call(route + '/commands', { expectedRevision: 0, operationId: randomUUID(), action: 'newScenario', args: ['Agent scenario'] }, 'agent');
  expect(scenario.status).toBe(200);
  const scenarioId = scenario.data.activeScenarioId as string;
  expect(scenarioId).toBeTruthy();
  const result = await call(route + '/commands', { expectedRevision: 1, operationId: randomUUID(), scenarioId,
    action: 'applyChanges', args: [{ activities: [{ id: 'activity-2', patch: { duration: 18 } }] }] }, 'agent');
  expect(result.data.model.activities.find((a: { id: string }) => a.id === 'activity-2').duration).toBe(12);
  expect(resolveScenario(result.data.model as ProjectModel, scenarioId).activities.find(a => a.id === 'activity-2')!.duration).toBe(18);
  const calculation = await call(route + '/calculate', { scenarioId, milestoneId: 'activity-7' }, 'agent');
  expect(calculation.status).toBe(200);
  expect(calculation.data.revision).toBe(2);
  expect(calculation.data.results.risk['activity-7'].totalRisk).toBeGreaterThan(0);
  const comparison = await call(route + '/compare', { scenarioId }, 'agent');
  expect(comparison.status).toBe(200);
  expect(comparison.data.comparison.activities.find((a: { activityId: string }) => a.activityId === 'activity-2').durationDelta).toBe(6);
});
it('persists duration proposals and finishes them without losing the underlying revision', async () => {
  const { route } = await register();
  const proposed = await call(route + '/commands', { expectedRevision: 0, operationId: randomUUID(), action: 'updateActivities', args: [['activity-2'], { effortHours: 88 }] });
  expect(proposed.data.pendingEdit.proposals).toHaveLength(1);
  expect(proposed.data.pendingEdit.revision).toBe(1);
  const finished = await call(route + '/commands', { expectedRevision: 1, operationId: randomUUID(), action: 'finishEdit', args: [[]] });
  expect(finished.status).toBe(200);
  expect(finished.data.pendingEdit).toBeUndefined();
  expect(finished.data.model.activities.find((a: { id: string }) => a.id === 'activity-2').effortHours).toBe(88);
  expect(finished.data.model.activities.find((a: { id: string }) => a.id === 'activity-2').duration).toBe(12);
});
it('rejects unauthenticated and cross-origin access and never overwrites registered projects', async () => {
  expect((await fetch(url + '/api/projects')).status).toBe(401);
  expect((await fetch(url + '/api/projects', { headers: { Authorization: `Bearer ${uiToken}`, Origin: 'https://untrusted.example' } })).status).toBe(403);
  const { model, route } = await register();
  model.project.name = 'Must not replace';
  const repeated = await call('/api/projects', { model, operationId: randomUUID() });
  expect(repeated.data.model.project.name).toBe('ERP Go Live');
  const before = await call(route);
  const preview = await call(route + '/preview', { expectedRevision: 0, operationId: randomUUID(), action: 'pasteActivities', args: [[{ code: 'PREVIEW', name: 'Preview only' }]] });
  expect(preview.data.preview).toBe(true);
  expect((await call(route)).data.model).toEqual(before.data.model);
});
it('allows UI layout/import transactions without exposing document replacement to agents', async () => {
  const model = publishBaseline(createDemo(), 'Immutable snapshot');
  const { route } = await register(model);
  const changed = structuredClone(model);
  changed.activities[0]!.graphPosition = { x: 123, y: 456 };
  const command = { expectedRevision: 0, operationId: randomUUID(), action: 'replaceDocument', args: [changed, 'Layout'] };
  expect((await call(route + '/commands', command, 'agent')).status).toBe(403);
  const accepted = await call(route + '/commands', command);
  expect(accepted.status).toBe(200);
  expect(accepted.data.model.activities[0].graphPosition).toEqual({ x: 123, y: 456 });
  changed.baselines[0]!.snapshot.activities[0]!.name = 'Cannot tamper';
  expect((await call(route + '/commands', { ...command, expectedRevision: 1, operationId: randomUUID() })).status).toBe(403);
});
