import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createProjectEngine, toModel } from '../../packages/application/src/index';
import { createConnection, type Approval, type RemoteSnapshot } from '../../apps/desktop/src/store/connection';
import { fixture } from '../helpers';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function setup() {
  const authoritative = fixture();
  authoritative.project.name = 'Authoritative server copy';
  const server = createProjectEngine(authoritative), browser = createProjectEngine(fixture());
  let revision = 8, conflict = false, approvals: Approval[] = [];
  const snapshot = (): RemoteSnapshot => {
    const s = server.getState();
    return { model: toModel(s.document), revision, activeScenarioId: s.activeScenarioId, pendingEdit: s.pendingEdit,
      dirty: s.dirty, canUndo: !!s.history.length, canRedo: !!s.future.length };
  };
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input), body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.endsWith('/commands')) {
      if (conflict || body.expectedRevision !== revision) return response({ error: 'Changed externally', code: 'REVISION_CONFLICT' }, 409);
      server.setState({ activeScenarioId: body.scenarioId, selectedActivityIds: body.selection.activityIds, selectedDependencyId: body.selection.dependencyId });
      if (body.action === 'replaceDocument') server.getState().requestEdit(body.args[1], () => body.args[0]);
      else {
        const action = server.getState()[body.action as keyof ReturnType<typeof server.getState>] as (...args: unknown[]) => unknown;
        action(...body.args);
      }
      revision++;
      return response(snapshot());
    }
    if (url.endsWith('/operations')) return response(approvals);
    return response(snapshot());
  });
  const controller = createConnection(browser, fetcher);
  return { server, browser, controller, fetcher, setConflict: (value: boolean) => { conflict = value; },
    setApprovals: (value: Approval[]) => { approvals = value; }, snapshot };
}

it('is opt-in and registers without overwriting an existing authoritative project', async () => {
  const { browser, controller, fetcher } = setup();
  browser.getState().addActivity();
  expect(fetcher).not.toHaveBeenCalled();
  expect(await controller.connect('http://127.0.0.1:1430', 'ui-secret')).toBe(true);
  expect(toModel(browser.getState().document).project.name).toBe('Authoritative server copy');
  expect(browser.getState().notice).toContain('local file or model was not applied');
  expect(fetcher.mock.calls[0]![1]?.headers).toHaveProperty('Authorization', 'Bearer ui-secret');
  expect(controller.state.getState()).not.toHaveProperty('token');
  const registration = JSON.parse(String(fetcher.mock.calls[0]![1]?.body));
  expect(registration.operationId).toBeTruthy();
  expect(registration.model.activities).toHaveLength(fixture().activities.length + 1);
});

it('waits for authoritative writes and includes per-request scenario and selection context', async () => {
  const { browser, controller, fetcher, server } = setup();
  await controller.connect('http://127.0.0.1:1430', 'token');
  const id = toModel(browser.getState().document).activities[0]!.id;
  browser.getState().select([id]);
  browser.getState().updateActivities([id], { name: 'Remote edit' });
  expect(toModel(browser.getState().document).activities[0]!.name).not.toBe('Remote edit');
  await controller.settle();
  expect(toModel(server.getState().document).activities[0]!.name).toBe('Remote edit');
  const body = JSON.parse(String(fetcher.mock.calls.at(-1)![1]?.body));
  expect(body).toMatchObject({ expectedRevision: 8, action: 'updateActivities', selection: { activityIds: [id] } });
  expect(browser.getState().history).toHaveLength(1);
  browser.getState().undo(); await controller.settle();
  expect(toModel(browser.getState().document).activities[0]!.name).not.toBe('Remote edit');
});

it('blocks conflicts without replay or silent local fallback and explicitly refreshes', async () => {
  const { browser, controller, setConflict, fetcher } = setup();
  await controller.connect('http://127.0.0.1:1430', 'token');
  const before = toModel(browser.getState().document);
  setConflict(true);
  browser.getState().addActivity();
  await expect(controller.settle()).rejects.toThrow('Revision conflict');
  expect(toModel(browser.getState().document)).toEqual(before);
  const count = fetcher.mock.calls.length;
  browser.getState().addActivity();
  expect(fetcher).toHaveBeenCalledTimes(count);
  expect(controller.connected()).toBe(true);
  setConflict(false); await controller.refresh();
  browser.getState().addActivity(); await controller.settle();
  expect(toModel(browser.getState().document).activities.length).toBe(before.activities.length + 1);
});

it('roundtrips pending duration proposals and safe remote undo', async () => {
  const { browser, controller } = setup();
  await controller.connect('http://127.0.0.1:1430', 'token');
  const before = toModel(browser.getState().document), id = before.activities[0]!.id;
  browser.getState().updateActivities([id], { effortHours: 40 }); await controller.settle();
  expect(browser.getState().pendingEdit?.proposals).toHaveLength(1);
  browser.getState().finishEdit([id]); await controller.settle();
  expect(browser.getState().pendingEdit).toBeUndefined();
  expect(toModel(browser.getState().document).activities[0]!.effortHours).toBe(40);
  browser.getState().undo(); await controller.settle();
  expect(toModel(browser.getState().document).activities[0]!.effortHours).toBe(before.activities[0]!.effortHours);
});

it('keeps scenario selection local and submits server revision instead of selection revision', async () => {
  const { browser, controller, server, fetcher } = setup();
  server.getState().newScenario('What if');
  const scenarioId = server.getState().activeScenarioId!;
  await controller.connect('http://127.0.0.1:1430', 'token');
  browser.getState().activateScenario(scenarioId);
  expect(browser.getState().revision).toBe(9);
  const id = toModel(browser.getState().document).activities[0]!.id;
  browser.getState().updateActivities([id], { name: 'Scenario-only name' });
  await controller.settle();
  const sent = JSON.parse(String(fetcher.mock.calls.at(-1)![1]?.body));
  expect(sent).toMatchObject({ scenarioId, expectedRevision: 8 });
  expect(toModel(browser.getState().document).activities[0]!.name).not.toBe('Scenario-only name');
});

it('polls pending approvals even without document revision changes and authenticates UI decisions', async () => {
  const { controller, setApprovals, fetcher } = setup();
  await controller.connect('http://127.0.0.1:1430', 'ui-only-token');
  const approval: Approval = { id: 'approval-1', status: 'pending', action: 'updateActivities', args: [],
    expectedRevision: 8, expiresAt: '2026-11-12T00:00:00Z' };
  setApprovals([approval]);
  await vi.advanceTimersByTimeAsync(2000);
  expect(controller.state.getState().approvals).toEqual([approval]);
  expect(controller.state.getState().revision).toBe(8);
  await controller.decide(approval.id, false);
  const call = fetcher.mock.calls.find(([url]) => String(url).endsWith('/operations/approval-1/decision'))!;
  expect(call[1]?.headers).toHaveProperty('Authorization', 'Bearer ui-only-token');
  expect(JSON.parse(String(call[1]?.body))).toEqual({ approve: false });
});

it('does not save independent local edits after network loss and never silently falls back', async () => {
  const { browser, controller, fetcher } = setup();
  await controller.connect('http://127.0.0.1:1430', 'token');
  const before = toModel(browser.getState().document);
  fetcher.mockRejectedValueOnce(new TypeError('Network unavailable'));
  browser.getState().addActivity();
  await expect(controller.settle()).rejects.toThrow('Network unavailable');
  expect(controller.connected()).toBe(true);
  expect(toModel(browser.getState().document)).toEqual(before);
  await controller.refresh();
  expect(controller.state.getState().error).toBeUndefined();
  browser.getState().saveCompleted(browser.getState().revision, undefined, false);
  await controller.settle();
  const sent = JSON.parse(String(fetcher.mock.calls.at(-1)![1]?.body));
  expect(sent.action).toBe('saveCompleted');
  expect(sent.args).toEqual([8, null, false]);
});

it('sends callback candidates through UI-only CAS replacement without applying a local commit', async () => {
  const { browser, controller, fetcher } = setup();
  await controller.connect('http://127.0.0.1:1430', 'token');
  browser.getState().commit('Import activity effort', model => {
    model.activities[0]!.effortHours = 40;
    return model;
  });
  expect(toModel(browser.getState().document).activities[0]!.effortHours).not.toBe(40);
  await controller.settle();
  const sent = JSON.parse(String(fetcher.mock.calls.at(-1)![1]?.body));
  expect(sent).toMatchObject({ action: 'replaceDocument', expectedRevision: 8 });
  expect(sent.args[1]).toBe('Import activity effort');
  expect(browser.getState().pendingEdit?.proposals).toHaveLength(1);
  expect(toModel(browser.getState().document).activities[0]!.effortHours).not.toBe(40);
  browser.getState().finishEdit([]); await controller.settle();
  expect(toModel(browser.getState().document).activities[0]!.effortHours).toBe(40);
});

it('never sends UI credentials to remote URLs and normalizes localhost for service Host checks', async () => {
  const { controller, fetcher } = setup();
  for (const url of ['https://127.0.0.1:1430', 'http://example.com:1430', 'http://[::1]:1430',
    'http://127.0.0.1:1430/another-service', 'http://user:password@127.0.0.1:1430']) {
    await expect(controller.connect(url, 'private-ui-token')).rejects.toThrow('local service URL');
  }
  expect(fetcher).not.toHaveBeenCalled();
  expect(await controller.connect('http://localhost:1430', 'private-ui-token')).toBe(true);
  expect(fetcher.mock.calls[0]![0]).toBe('http://127.0.0.1:1430/api/projects');
});
