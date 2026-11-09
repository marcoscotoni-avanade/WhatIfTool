import { create } from 'zustand';
import { createActivity, createProject, validateProject, type Activity, type CalculationResults, type Dependency, type EntityType, type ProjectModel, type ScenarioComparison } from '@planner/domain';
import { createScenario, deleteScenario, publishBaseline, resolveScenario, validateDocument, writeOverride } from '@planner/scenarios';
import { command, normalize, toModel, type DocumentCommand, type DocumentState } from './document';

interface Store {
  document: DocumentState; revision: number; dirty: boolean; path?: string; activeScenarioId?: string;
  selectedActivityIds: string[]; selectedDependencyId?: string; activeMilestoneId?: string;
  riskFlow: boolean; viewMode: 'split' | 'graph' | 'grid'; calculationStatus: 'idle' | 'calculating' | 'ready' | 'error';
  results?: CalculationResults; comparison?: ScenarioComparison; error?: string; notice?: string;
  history: DocumentCommand[]; future: DocumentCommand[];
  commit(name: string, mutate: (m: ProjectModel) => ProjectModel, scenarioId?: string): boolean;
  load(m: ProjectModel, path?: string): void; saveCompleted(revision: number, path?: string): void;
  updateEntity(type: EntityType, id: string, patch: Record<string, unknown>): void;
  updateActivities(ids: string[], patch: Partial<Activity>): void;
  addActivity(milestone?: boolean): void; duplicateSelection(): void; deleteSelection(): void;
  connect(predecessorId: string, successorId: string, type?: Dependency['type'], lag?: number, lagUnit?: Dependency['lagUnit']): void;
  select(ids: string[], dependencyId?: string): void;
  activateScenario(id?: string): void; newScenario(name: string, clone?: boolean): void;
  renameScenario(name: string): void; removeScenario(): void; baseline(name: string): void;
  undo(): void; redo(): void; report(error: unknown): void;
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export const useProjectStore = create<Store>((set, get) => ({
  document: normalize(createProject()), revision: 0, dirty: false, selectedActivityIds: [], riskFlow: false,
  viewMode: 'split', calculationStatus: 'idle', history: [], future: [],
  report: error => { console.error('[planner]', { message: message(error), at: new Date().toISOString() }); set({ error: message(error) }); },
  commit: (name, mutate, scenarioId = get().activeScenarioId) => {
    try {
      const state = get(), m = mutate(structuredClone(toModel(state.document)));
      m.project.modifiedAt = new Date().toISOString();
      validateDocument(m);
      const next = normalize(m), cmd = command(name, state.document, next, state.activeScenarioId, scenarioId);
      set({ document: cmd.execute(), activeScenarioId: scenarioId, revision: state.revision + 1, dirty: true,
        history: [...state.history, cmd].slice(-60), future: [], comparison: undefined, error: undefined, calculationStatus: 'calculating' });
      return true;
    } catch (error) { get().report(error); return false; }
  },
  load: (m, path) => {
    try {
      validateDocument(m);
      set(s => ({ document: normalize(m), revision: s.revision + 1, dirty: false, path, activeScenarioId: undefined,
        selectedActivityIds: [], selectedDependencyId: undefined, activeMilestoneId: undefined, history: [], future: [],
        results: undefined, comparison: undefined, error: undefined, calculationStatus: 'calculating' }));
    } catch (error) { get().report(error); }
  },
  saveCompleted: (revision, path) => set(s => ({ dirty: s.revision !== revision, path: path ?? s.path, notice: 'Project saved locally.' })),
  updateEntity: (type, id, patch) => {
    get().commit(`Update ${type}`, m => {
      if (get().activeScenarioId) {
        for (const [field, value] of Object.entries(patch)) writeOverride(m, get().activeScenarioId!, type, id, field, value);
      } else {
        const entity = type === 'activity' ? m.activities.find(a => a.id === id) : type === 'dependency' ? m.dependencies.find(d => d.id === id)
          : type === 'calendar' ? m.calendars.find(c => c.id === id) : type === 'project' ? m.project : m.settings;
        if (!entity) throw new Error('Entity not found.');
        for (const [field, value] of Object.entries(patch)) {
          if (['id', 'projectId', 'calculatedStart', 'calculatedFinish', '__proto__', 'constructor', 'prototype'].includes(field)) throw new Error('This field is not editable.');
          Reflect.set(entity, field, value);
        }
      }
      return m;
    });
  },
  updateActivities: (ids, patch) => {
    get().commit('Edit activities', m => {
      for (const id of ids) {
        if (get().activeScenarioId) {
          for (const [field, value] of Object.entries(patch)) writeOverride(m, get().activeScenarioId!, 'activity', id, field, value);
        } else {
          const a = m.activities.find(a => a.id === id);
          if (!a) throw new Error('Activity not found.');
          Object.assign(a, patch);
        }
      }
      return m;
    });
  },
  addActivity: (milestone = false) => {
    const state = get(), resolved = resolveScenario(toModel(state.document), state.activeScenarioId);
    const a = createActivity(resolved.project.id, resolved.activities.length + 1, milestone);
    const codes = new Set(resolved.activities.map(x => x.code));
    let n = resolved.activities.length + 1;
    while (codes.has(a.code)) a.code = `${milestone ? 'MS' : 'ACT'}-${++n}`;
    if (get().commit('Create activity', m => {
      if (state.activeScenarioId) writeOverride(m, state.activeScenarioId, 'activity', a.id, '$entity', a);
      else m.activities.push(a);
      return m;
    })) get().select([a.id]);
  },
  duplicateSelection: () => {
    const state = get(), resolved = resolveScenario(toModel(state.document), state.activeScenarioId);
    const copies = resolved.activities.filter(a => state.selectedActivityIds.includes(a.id)).map(a => ({
      ...a, id: crypto.randomUUID(), code: `${a.code}-COPY-${crypto.randomUUID().slice(0, 4)}`, name: `${a.name} (copy)`,
      graphPosition: { x: a.graphPosition.x + 40, y: a.graphPosition.y + 60 },
    }));
    if (get().commit('Duplicate activities', m => {
      for (const a of copies) if (state.activeScenarioId) writeOverride(m, state.activeScenarioId, 'activity', a.id, '$entity', a); else m.activities.push(a);
      return m;
    })) get().select(copies.map(a => a.id));
  },
  deleteSelection: () => {
    const state = get(), resolved = resolveScenario(toModel(state.document), state.activeScenarioId);
    const ids = new Set(state.selectedActivityIds);
    const edges = resolved.dependencies.filter(d => ids.has(d.predecessorId) || ids.has(d.successorId) || d.id === state.selectedDependencyId);
    if (get().commit('Delete selection', m => {
      if (state.activeScenarioId) {
        for (const d of edges) writeOverride(m, state.activeScenarioId, 'dependency', d.id, '$entity', null);
        for (const id of ids) writeOverride(m, state.activeScenarioId, 'activity', id, '$entity', null);
      } else {
        m.dependencies = m.dependencies.filter(d => !edges.some(e => e.id === d.id));
        m.activities = m.activities.filter(a => !ids.has(a.id));
      }
      return m;
    })) set({ selectedActivityIds: [], selectedDependencyId: undefined, activeMilestoneId: ids.has(state.activeMilestoneId ?? '') ? undefined : state.activeMilestoneId });
  },
  connect: (predecessorId, successorId, type = 'FS', lag = 0, lagUnit = 'd') => {
    const state = get();
    get().commit('Create dependency', m => {
      const d: Dependency = { id: crypto.randomUUID(), projectId: m.project.id, predecessorId, successorId, type, lag, lagUnit };
      // Resolve and validate the hypothetical edge before it reaches canonical state or history.
      const resolved = resolveScenario(m, state.activeScenarioId);
      validateProject({ ...resolved, dependencies: [...resolved.dependencies, d] });
      if (state.activeScenarioId) writeOverride(m, state.activeScenarioId, 'dependency', d.id, '$entity', d);
      else m.dependencies.push(d);
      return m;
    });
  },
  select: (ids, dependencyId) => set({ selectedActivityIds: ids, selectedDependencyId: dependencyId }),
  activateScenario: id => {
    try {
      resolveScenario(toModel(get().document), id);
      set(s => ({ activeScenarioId: id, selectedActivityIds: [], selectedDependencyId: undefined, activeMilestoneId: undefined,
        results: undefined, comparison: undefined, revision: s.revision + 1, error: undefined, calculationStatus: 'calculating' }));
    } catch (error) { get().report(error); }
  },
  newScenario: (name, clone = false) => {
    const state = get(), value = createScenario(toModel(state.document), name, clone ? state.activeScenarioId : undefined);
    get().commit('Create scenario', () => value.model, value.id);
  },
  renameScenario: name => {
    get().commit('Rename scenario', m => {
      const s = m.scenarios.find(s => s.id === get().activeScenarioId);
      if (!s || s.isBaseline) throw new Error('Select an editable scenario.');
      s.name = name;
      return m;
    });
  },
  removeScenario: () => {
    const id = get().activeScenarioId;
    if (id && get().commit('Delete scenario', m => deleteScenario(m, id))) get().activateScenario(undefined);
  },
  baseline: name => {
    const state = get(), next = publishBaseline(toModel(state.document), name, state.activeScenarioId);
    get().commit('Publish baseline', () => next, next.scenarios.at(-1)!.id);
  },
  undo: () => {
    const state = get(), cmd = state.history.at(-1);
    if (cmd) set({ document: cmd.undo(), activeScenarioId: cmd.beforeScenarioId, history: state.history.slice(0, -1), future: [...state.future, cmd],
      dirty: true, revision: state.revision + 1, selectedActivityIds: [], selectedDependencyId: undefined, activeMilestoneId: undefined, comparison: undefined, calculationStatus: 'calculating' });
  },
  redo: () => {
    const state = get(), cmd = state.future.at(-1);
    if (cmd) set({ document: cmd.redo(), activeScenarioId: cmd.afterScenarioId, history: [...state.history, cmd], future: state.future.slice(0, -1),
      dirty: true, revision: state.revision + 1, selectedActivityIds: [], selectedDependencyId: undefined, activeMilestoneId: undefined, comparison: undefined, calculationStatus: 'calculating' });
  },
}));
