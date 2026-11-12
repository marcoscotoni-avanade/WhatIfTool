import { createStore, type StoreApi } from 'zustand/vanilla';
import { parseProject, type ProjectModel } from '@planner/domain';
import { resolveScenario } from '@planner/scenarios';
import { command, normalize, toModel, type PendingEdit, type PlannerState } from '../../../../packages/application/src/index';

export interface RemoteSnapshot {
  model: ProjectModel; revision: number; activeScenarioId?: string; pendingEdit?: PendingEdit;
  dirty: boolean; canUndo: boolean; canRedo: boolean;
}
export interface Approval {
  id: string; status: string; action: string; scenarioId?: string; args: unknown[];
  expectedRevision: number; expiresAt: string;
  diff?: { target: string; id: string; before?: unknown; after?: unknown }[];
}
export interface ImportApproval {
  id: string; operationId: string; status: string; expiresAt: string; hash: string; reason?: string;
  projectId: string; name: string;
  counts: { activities: number; dependencies: number; scenarios: number; baselines: number; calendars: number };
}
export interface ConnectionState {
  mode: 'standalone' | 'connected'; url: string; busy: boolean;
  error?: string; revision?: number; approvals: Approval[];
}
const actions = ['updateEntity', 'updateActivities', 'updateActivityPatches', 'pasteActivities', 'addActivity',
  'duplicateSelection', 'deleteSelection', 'connect', 'newScenario', 'renameScenario', 'removeScenario',
  'baseline', 'manageBaseline', 'finishEdit', 'undo', 'redo', 'setTagCatalog', 'saveCompleted'] as const;

export function createConnection(store: StoreApi<PlannerState>, fetcher: typeof fetch = (...args) => fetch(...args)) {
  const state = createStore<ConnectionState>(() => ({
    mode: 'standalone', url: 'http://127.0.0.1:1430', busy: false, approvals: [],
  }));
  const original = { ...store.getState() };
  let token = '', projectId = '', timer: ReturnType<typeof setInterval> | undefined;
  let outstanding: Promise<unknown> = Promise.resolve();
  let snapshotKey = '';
  const connected = () => state.getState().mode === 'connected';
  const fail = (error: unknown) => {
    const text = error instanceof Error ? error.message : String(error);
    state.setState({ error: text }); store.getState().report(text);
  };
  async function request<T>(path: string, method = 'GET', body?: unknown, prefix = '/api/projects'): Promise<T> {
    const response = await fetcher(`${state.getState().url}${prefix}${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      signal: AbortSignal.timeout(15_000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(response.status === 409
        ? `Revision conflict: ${error.error ?? 'project changed'}. Refresh before retrying; your write was not replayed.`
        : error.error ?? `Service request failed (${response.status}). Refresh before retrying.`);
    }
    return await response.json() as T;
  }
  function apply(snapshot: RemoteSnapshot, changeScenario = false, force = false) {
    const key = JSON.stringify(snapshot);
    if (!force && snapshotKey === key) return;
    const document = normalize(parseProject(snapshot.model)), current = store.getState();
    const activeScenarioId = snapshot.pendingEdit ? snapshot.pendingEdit.scenarioId : changeScenario ? snapshot.activeScenarioId
      : current.activeScenarioId && document.scenariosById[current.activeScenarioId] ? current.activeScenarioId : undefined;
    const resolved = resolveScenario(snapshot.model, activeScenarioId);
    const activityIds = new Set(resolved.activities.map(activity => activity.id));
    const marker = command('Server history', document, document, activeScenarioId, activeScenarioId);
    store.setState({ document, revision: snapshot.revision, activeScenarioId, dirty: snapshot.dirty,
      pendingEdit: snapshot.pendingEdit, history: snapshot.canUndo ? [marker] : [], future: snapshot.canRedo ? [marker] : [],
      selectedActivityIds: current.selectedActivityIds.filter(id => activityIds.has(id)),
      selectedDependencyId: resolved.dependencies.some(dependency => dependency.id === current.selectedDependencyId) ? current.selectedDependencyId : undefined,
      activeMilestoneId: current.activeMilestoneId && activityIds.has(current.activeMilestoneId) ? current.activeMilestoneId : undefined,
      results: undefined, comparison: undefined, calculationStatus: 'calculating', error: undefined });
    snapshotKey = key;
    state.setState({ revision: snapshot.revision });
  }
  async function refresh() {
    if (!connected()) return;
    const snapshot = await request<RemoteSnapshot>(`/${encodeURIComponent(projectId)}`);
    apply(snapshot);
    const approvals = await request<Approval[]>(`/${encodeURIComponent(projectId)}/operations`);
    state.setState({ approvals, error: undefined });
  }
  function run<T>(work: () => Promise<T>): Promise<T | false> {
    if (state.getState().busy) { fail(new Error('A service request is still in progress. Wait before retrying.')); return Promise.resolve(false); }
    state.setState({ busy: true });
    const task = work().catch(error => { fail(error); return false as const; })
      .finally(() => state.setState({ busy: false }));
    outstanding = task;
    return task;
  }
  const commandPath = () => `/${encodeURIComponent(projectId)}/commands`;
  function replaceDocument(name: string, mutate: (model: ProjectModel) => ProjectModel): boolean {
    if (state.getState().error) { fail(new Error('Service is blocked. Refresh to recover before retrying.')); return false; }
    const current = store.getState();
    return run(async () => {
      const candidate = mutate(structuredClone(toModel(current.document)));
      const snapshot = await request<RemoteSnapshot>(commandPath(), 'POST', {
        expectedRevision: state.getState().revision, operationId: crypto.randomUUID(), action: 'replaceDocument',
        args: [candidate, name], scenarioId: current.activeScenarioId,
        selection: { activityIds: [...current.selectedActivityIds], dependencyId: current.selectedDependencyId },
      });
      apply(snapshot, false, true);
      return true;
    }) as unknown as boolean;
  }
  for (const action of actions) {
    const local = original[action] as (...args: unknown[]) => unknown;
    const remote = (...args: unknown[]) => {
      if (!connected()) return local(...args);
      if (state.getState().error) { fail(new Error('Service is blocked. Refresh to recover before retrying.')); return false; }
      const current = store.getState(), scenarioId = current.activeScenarioId;
      const selection = { activityIds: [...current.selectedActivityIds], dependencyId: current.selectedDependencyId };
      const previousIds = new Set(resolveScenario(toModel(current.document), scenarioId).activities.map(activity => activity.id));
      return run(async () => {
        const snapshot = await request<RemoteSnapshot>(commandPath(), 'POST', {
          expectedRevision: state.getState().revision, operationId: crypto.randomUUID(), action, args, scenarioId, selection,
        });
        apply(snapshot, ['newScenario', 'baseline', 'manageBaseline', 'undo', 'redo', 'removeScenario'].includes(action), true);
        if (action === 'addActivity' || action === 'duplicateSelection') {
          original.select(resolveScenario(snapshot.model, scenarioId).activities.map(activity => activity.id).filter(id => !previousIds.has(id)));
        } else if (action === 'deleteSelection') original.select([]);
        return true;
      });
    };
    store.setState({ [action]: remote } as Partial<PlannerState>);
  }
  store.setState({
    commit: (...args) => {
      if (!connected()) return original.commit(...args);
      return replaceDocument(args[0], args[1]);
    },
    requestEdit: (...args) => {
      if (!connected()) return original.requestEdit(...args);
      return replaceDocument(args[0], args[1]);
    },
    load: (model, path) => {
      if (!connected()) { original.load(model, path); return; }
      void register(model, path);
    },
    activateScenario: id => {
      if (!connected()) { original.activateScenario(id); return; }
      if (state.getState().busy || store.getState().pendingEdit) {
        fail(new Error('Finish the current request or duration proposal before switching scenarios.')); return;
      }
      original.activateScenario(id);
    },
  });
  function register(model: ProjectModel, path?: string) {
    return run(async () => {
      if (store.getState().pendingEdit) throw new Error('Complete or cancel the pending duration proposal before opening another project.');
      const snapshot = await request<RemoteSnapshot>('', 'POST', { model, operationId: crypto.randomUUID() });
      projectId = snapshot.model.project.id;
      store.setState({ activeScenarioId: undefined, selectedActivityIds: [], selectedDependencyId: undefined, path });
      apply(snapshot, false, true);
      if (JSON.stringify(parseProject(model)) !== JSON.stringify(parseProject(snapshot.model))) {
        store.setState({ notice: 'This project ID already exists on the service. Opened the authoritative server version; the local file or model was not applied.' });
      }
      state.setState({ error: undefined, approvals: [] });
      return true;
    });
  }
  return {
    state, connected,
    async connect(url: string, uiToken: string) {
      if (connected()) throw new Error('Disconnect before changing the service connection.');
      if (store.getState().pendingEdit) throw new Error('Complete or cancel the pending duration proposal before connecting.');
      const parsed = new URL(url);
      if (parsed.hostname === 'localhost') parsed.hostname = '127.0.0.1';
      if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port
        || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
        throw new Error('Use a local service URL: http://127.0.0.1:<port>, without credentials, path, query or fragment.');
      }
      if (!uiToken.trim()) throw new Error('A UI token is required.');
      token = uiToken;
      state.setState({ url: parsed.href.replace(/\/$/, ''), mode: 'connected', error: undefined });
      const ok = await register(toModel(store.getState().document), store.getState().path);
      if (!ok) { state.setState({ mode: 'standalone' }); token = ''; return false; }
      timer = setInterval(() => {
        if (!state.getState().busy && !state.getState().error) void run(refresh);
      }, 2000);
      return true;
    },
    disconnect() {
      if (state.getState().busy) throw new Error('Wait for the current service request before disconnecting.');
      if (store.getState().pendingEdit) throw new Error('Complete or cancel the duration proposal before disconnecting.');
      if (timer) clearInterval(timer);
      token = ''; projectId = ''; snapshotKey = '';
      // Start a new local history; remote undo markers are not executable local history.
      store.setState({ history: [], future: [], dirty: true });
      state.setState({ mode: 'standalone', busy: false, revision: undefined, approvals: [], error: undefined });
    },
    refresh: () => run(refresh),
    listProjects: () => request<{ id: string; name: string; revision: number }[]>(''),
    listImports: () => request<ImportApproval[]>('', 'GET', undefined, '/api/imports'),
    decideImport: (id: string, approve: boolean) => request<ImportApproval>(`/${encodeURIComponent(id)}/decision`, 'POST', { approve }, '/api/imports'),
    openProject: (id: string) => run(async () => {
      if (store.getState().pendingEdit) throw new Error('Complete or cancel the pending duration proposal first.');
      const snapshot = await request<RemoteSnapshot>(`/${encodeURIComponent(id)}`);
      projectId = id; store.setState({ activeScenarioId: undefined, path: undefined, selectedActivityIds: [], selectedDependencyId: undefined });
      apply(snapshot, false, true); state.setState({ error: undefined, approvals: [] });
      return true;
    }),
    decide: (id: string, approve: boolean) => run(async () => {
      if (state.getState().error) throw new Error('Refresh before deciding an operation.');
      await request(`/${encodeURIComponent(projectId)}/operations/${encodeURIComponent(id)}/decision`, 'POST', { approve });
      await refresh(); return true;
    }),
    async settle() { const result = await outstanding; if (result === false || state.getState().error) throw new Error(state.getState().error ?? 'Service write failed.'); },
  };
}
