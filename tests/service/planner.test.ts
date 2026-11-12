import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDemo, createProject, type ProjectModel } from '@planner/domain';
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
it('filters and pages activities on one service snapshot, including calculated dates', async () => {
  const model = createDemo();
  model.project.tagCatalog = ['Équipe', 'urgent'];
  model.activities[0]!.tags = ['Équipe', 'urgent'];
  model.activities[1]!.tags = ['Équipe'];
  const { route } = await register(model);
  const query = { scenarioId: null, limit: 1, offset: 0 };
  const tags = await call(route + '/activities/query', { ...query, text: 'DESIGN',
    tags: { values: ['Équipe', 'urgent'], match: 'all' } }, 'agent');
  expect(tags.status).toBe(200);
  expect(tags.data).toMatchObject({ total: 1, revision: 0, items: [{ id: 'activity-0' }] });
  const any = await call(route + '/activities/query', { ...query, offset: 1,
    tags: { values: ['Équipe'], match: 'any' }, sort: { field: 'name', direction: 'asc' } }, 'agent');
  expect(any.data).toMatchObject({ total: 2, items: [{ id: 'activity-0' }] });
  const dates = await call(route + '/activities/query', { ...query, limit: 100,
    date: { field: 'plannedFinish', from: '2026-11-11', to: '2026-11-11' } }, 'agent');
  expect(dates.data.items.map((item: { id: string }) => item.id)).toEqual(['activity-0']);
  const calculated = await call(route + '/activities/query', { ...query, limit: 100,
    date: { field: 'calculatedStart', from: '2026-11-09', to: '2026-11-09' } }, 'agent');
  expect(calculated.status).toBe(200);
  expect(calculated.data.items.map((item: { id: string }) => item.id)).toContain('activity-0');
  expect((await call(route + '/activities/query', { ...query, scenarioId: 'missing' }, 'agent')).status).toBe(404);
  expect((await call(route + '/activities/query', { ...query, date: { field: 'plannedStart', from: '2026-12-01', to: '2026-11-01' } }, 'agent')).status).toBe(400);
});
it('reports bounded dependency traversal and planning diagnostics without altering the project', async () => {
  const model = createDemo();
  model.activities[0]!.duration = 0;
  const { route } = await register(model);
  const query = { scenarioId: null, limit: 100, offset: 0 };
  const edges = await call(route + '/dependencies/query', { ...query, analyze: true,
    traversal: { activityId: 'activity-0', direction: 'descendants', maxDepth: 1 } }, 'agent');
  expect(edges.status).toBe(200);
  expect(edges.data.items.map((item: { id: string }) => item.id)).toEqual(['edge-0', 'edge-1']);
  expect(edges.data.items[0].predecessorSchedule).toMatchObject({ activityId: 'activity-0', critical: expect.any(Boolean) });
  const diagnostics = await call(route + '/diagnose', { ...query, milestoneId: 'activity-7' }, 'agent');
  expect(diagnostics.status).toBe(200);
  expect(diagnostics.data.items).toContainEqual(expect.objectContaining({ code: 'ZERO_TASK_DURATION', activityId: 'activity-0' }));
  expect(diagnostics.data.revision).toBe(0);
  expect((await call(route)).data.revision).toBe(0);
  expect((await call(route + '/diagnose', { ...query, milestoneId: 'activity-0' }, 'agent')).status).toBe(404);
});
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
  const history = await call(route + '/history/query', { limit: 10, offset: 0, outcome: 'failed:REVISION_CONFLICT' }, 'agent');
  expect(history.data).toMatchObject({ revision: 1, total: 1, retentionLimit: 1000,
    items: [{ actor: 'ui', action: 'pasteActivities', outcome: 'failed:REVISION_CONFLICT' }] });
  expect(history.data.items[0]).not.toHaveProperty('args');
  expect((await call(route + '/commands', { action: 'invalid', secret: 'must-not-be-recorded' }, 'agent')).status).toBe(400);
  const invalidHistory = await call(route + '/history/query', { limit: 10, offset: 0, actor: 'agent', action: 'invalid_command' }, 'agent');
  expect(invalidHistory.data.items).toMatchObject([{ outcome: 'failed:INVALID_INPUT' }]);
  expect(JSON.stringify(invalidHistory.data)).not.toContain('must-not-be-recorded');
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
it('protects agent duration proposal resolution with a stable id, validation, and UI approval', async () => {
  const { route } = await register();
  const proposed = await call(route + '/commands', { expectedRevision: 0, operationId: randomUUID(),
    action: 'updateActivities', args: [['activity-2'], { effortHours: 88 }] });
  const proposal = (await call(route + '/duration-proposal', { scenarioId: null }, 'agent')).data.proposal;
  expect(proposal.id).toBeTruthy();
  expect(proposal.id).toBe(proposed.data.pendingEdit.id);
  const command = { expectedRevision: 1, operationId: randomUUID(), action: 'finishEdit', args: [['activity-2'], proposal.id] };
  expect((await call(route + '/commands', { ...command, args: [['activity-2'], 'wrong'] }, 'agent')).status).toBe(409);
  expect((await call(route + '/commands', { ...command, args: [['unknown'], proposal.id] }, 'agent')).status).toBe(422);
  const pending = await call(route + '/commands', command, 'agent');
  expect(pending.data.status).toBe('approval_required');
  expect((await call(route)).data.pendingEdit.id).toBe(proposal.id);
  const accepted = await call(route + `/operations/${pending.data.operation.id}/decision`, { approve: true });
  expect(accepted.data.pendingEdit).toBeUndefined();
  expect(accepted.data.model.activities.find((a: { id: string }) => a.id === 'activity-2').duration).toBe(11);
});
it('migrates existing pending proposals once and retains their identifier after restart', async () => {
  const { route, id } = await register();
  await call(route + '/commands', { expectedRevision: 0, operationId: randomUUID(),
    action: 'updateActivities', args: [['activity-2'], { effortHours: 88 }] });
  const repository = new FileProjectRepository(directory);
  const record = (await repository.read(id))!;
  delete record.pendingEdit!.id;
  await app.close();
  await repository.write(record);
  app = await createPlannerServer({ directory, uiToken, agentToken, port: 0 });
  url = `http://127.0.0.1:${await app.listen()}`;
  const proposal = (await call(route + '/duration-proposal', { scenarioId: null }, 'agent')).data.proposal;
  expect(proposal.id).toBeTruthy();
  expect((await repository.read(id))!.pendingEdit!.id).toBe(proposal.id);
  await app.close();
  app = await createPlannerServer({ directory, uiToken, agentToken, port: 0 });
  url = `http://127.0.0.1:${await app.listen()}`;
  expect((await call(route + '/duration-proposal', { scenarioId: null }, 'agent')).data.proposal.id).toBe(proposal.id);
});
it('allows an approved agent to cancel a draft proposal without applying its edit', async () => {
  const { route } = await register();
  const proposed = await call(route + '/commands', { expectedRevision: 0, operationId: randomUUID(),
    action: 'updateActivities', args: [['activity-2'], { effortHours: 88 }] });
  const proposalId = proposed.data.pendingEdit.id;
  const command = { expectedRevision: 1, operationId: randomUUID(), action: 'finishEdit', args: [null, proposalId] };
  const requested = await call(route + '/commands', command, 'agent');
  expect(requested.data.status).toBe('approval_required');
  expect((await call(route + '/commands', command, 'agent')).data.replayed).toBe(true);
  const accepted = await call(route + `/operations/${requested.data.operation.id}/decision`, { approve: true });
  expect(accepted.data.pendingEdit).toBeUndefined();
  expect(accepted.data.model.activities.find((item: { id: string }) => item.id === 'activity-2').effortHours).toBe(72);
});
it('records expired approval outcomes without changing the project revision', async () => {
  const { route, id } = await register();
  const pending = await call(route + '/commands', { expectedRevision: 0, operationId: randomUUID(),
    action: 'updateActivities', args: [['activity-2'], { name: 'Pending' }] }, 'agent');
  const repository = new FileProjectRepository(directory);
  const record = (await repository.read(id))!;
  record.approvals[0]!.expiresAt = '2000-01-01T00:00:00.000Z';
  await app.close();
  await repository.write(record);
  app = await createPlannerServer({ directory, uiToken, agentToken, port: 0 });
  url = `http://127.0.0.1:${await app.listen()}`;
  expect((await call(route + `/operations/${pending.data.operation.id}`, undefined, 'agent')).data.status).toBe('expired');
  const history = await call(route + '/history/query', { limit: 10, offset: 0, actor: 'system', outcome: 'expired' }, 'agent');
  expect(history.data).toMatchObject({ revision: 0, total: 1, items: [{ outcome: 'expired' }] });
});
it('requires approval for scenario tag and team removals and validates assigned owners', async () => {
  const model = publishBaseline(createDemo(), 'Baseline');
  model.project.tagCatalog = ['one', 'two'];
  model.project.team = { name: 'Team', calendarId: 'standard', members: [{ id: 'member', name: 'Member', allocationPercent: 100 }] };
  model.activities[0]!.ownerId = 'member';
  model.baselines[0]!.snapshot.project = structuredClone(model.project);
  model.baselines[0]!.snapshot.activities = structuredClone(model.activities);
  const { route } = await register(model);
  const created = await call(route + '/commands', { expectedRevision: 0, operationId: randomUUID(), action: 'newScenario', args: ['Scenario'] }, 'agent');
  const scenarioId = created.data.activeScenarioId;
  const base = { expectedRevision: 1, operationId: randomUUID(), scenarioId };
  const tags = await call(route + '/commands', { ...base, action: 'setTagCatalog', args: [['one']] }, 'agent');
  expect(tags.data.status).toBe('approval_required');
  const bypass = await call(route + '/commands', { ...base, operationId: randomUUID(), action: 'updateEntity',
    args: ['project', model.project.id, { tagCatalog: ['one'] }] }, 'agent');
  expect(bypass.data.status).toBe('approval_required');
  const assigned = await call(route + '/commands', { ...base, operationId: randomUUID(), action: 'updateEntity',
    args: ['project', model.project.id, { team: { ...model.project.team, members: [] } }] }, 'agent');
  expect(assigned.status).toBe(422);
  const calendar = { ...model.calendars[0]!, id: 'alternate', name: 'Alternate' };
  const added = await call(route + '/commands', { ...base, operationId: randomUUID(), action: 'upsertCalendar', args: [calendar] }, 'agent');
  expect(added.status).toBe(200);
  const listed = await call(route + '/metadata', { scenarioId, kind: 'calendars', limit: 10, offset: 0 }, 'agent');
  expect(listed.data.items.map((item: { id: string }) => item.id)).toEqual(['alternate', 'standard']);
});
it('imports only after UI approval, recovers interrupted approvals, and never overwrites collisions', async () => {
  const model = createProject('Imported');
  const operationId = randomUUID();
  const document = { ...model, audit: [{ actor: 'injected' }], permissions: { agent: 'admin' } };
  const request = await call('/api/imports', { model: document, operationId }, 'agent');
  expect(request.status).toBe(200);
  expect(request.data.status).toBe('pending');
  expect((await call(`/api/projects/${model.project.id}`)).status).toBe(404);
  expect((await call('/api/imports', { model, operationId }, 'agent')).data.replayed).toBe(true);
  expect((await call(`/api/imports/${request.data.id}/decision`, { approve: true }, 'agent')).status).toBe(403);
  const queuePath = join(directory, '_imports', 'queue.json');
  const queue = JSON.parse(await readFile(queuePath, 'utf8'));
  queue[0].status = 'approving';
  await app.close();
  await writeFile(queuePath, JSON.stringify(queue));
  app = await createPlannerServer({ directory, uiToken, agentToken, port: 0 });
  url = `http://127.0.0.1:${await app.listen()}`;
  expect((await call(`/api/imports/${request.data.id}`, undefined, 'agent')).data.status).toBe('approved');
  const imported = (await call(`/api/projects/${model.project.id}`)).data;
  expect(imported.model.project.name).toBe('Imported');
  expect(imported.model).not.toHaveProperty('audit');
  expect(imported.model).not.toHaveProperty('permissions');
  expect((await call('/api/imports', { model, operationId: randomUUID() }, 'agent')).status).toBe(409);
  expect((await call(`/api/imports/${request.data.id}/decision`, { approve: true })).status).toBe(409);
  const collision = createProject('Collision');
  const pending = await call('/api/imports', { model: collision, operationId: randomUUID() }, 'agent');
  await call('/api/projects', { model: { ...collision, project: { ...collision.project, name: 'Existing' } }, operationId: randomUUID() });
  expect((await call(`/api/imports/${pending.data.id}/decision`, { approve: true })).data.status).toBe('conflict');
  expect((await call(`/api/projects/${collision.project.id}`)).data.model.project.name).toBe('Existing');
  const rejectedModel = createProject('Rejected');
  const rejected = await call('/api/imports', { model: rejectedModel, operationId: randomUUID() }, 'agent');
  expect((await call(`/api/imports/${rejected.data.id}/decision`, { approve: false })).data.status).toBe('rejected');
  expect((await call(`/api/projects/${rejectedModel.project.id}`)).status).toBe(404);
  expect((await call('/api/imports', { model: {}, operationId: randomUUID() }, 'agent')).status).toBe(422);
});
it('rejects a changed import payload during recovery', async () => {
  const model = createProject('Original');
  const pending = await call('/api/imports', { model, operationId: randomUUID() }, 'agent');
  const queuePath = join(directory, '_imports', 'queue.json');
  const queue = JSON.parse(await readFile(queuePath, 'utf8'));
  queue[0].status = 'approving';
  queue[0].model.project.name = 'Changed after approval';
  await app.close();
  await writeFile(queuePath, JSON.stringify(queue));
  app = await createPlannerServer({ directory, uiToken, agentToken, port: 0 });
  url = `http://127.0.0.1:${await app.listen()}`;
  expect((await call(`/api/imports/${pending.data.id}`, undefined, 'agent')).data)
    .toMatchObject({ status: 'conflict', reason: 'PAYLOAD_CHANGED' });
  expect((await call(`/api/projects/${model.project.id}`)).status).toBe(404);
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
