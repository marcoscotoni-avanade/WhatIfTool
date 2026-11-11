import { create } from 'zustand';
import { createActivity, createProject, parseProject, validateProject, type Activity, type CalculationResults, type Dependency, type EntityType, type ProjectModel, type ScenarioComparison } from '@planner/domain';
import { createScenario, deleteScenario, publishBaseline, resolveScenario, validateDocument, writeOverride } from '@planner/scenarios';
import { command, normalize, toModel, type DocumentCommand, type DocumentState } from './document';
import { proposeDuration, type DurationProposal } from './durationProposal';
import { activityPatch, editableActivityFields } from './editing';

interface PendingEdit { name: string; model: ProjectModel; revision: number; scenarioId?: string; proposals: DurationProposal[] }

interface Store {
  document: DocumentState; revision: number; dirty: boolean; path?: string; activeScenarioId?: string;
  selectedActivityIds: string[]; selectedDependencyId?: string; activeMilestoneId?: string;
  riskFlow: boolean; viewMode: 'split' | 'graph' | 'grid'; calculationStatus: 'idle' | 'calculating' | 'ready' | 'error';
  results?: CalculationResults; comparison?: ScenarioComparison; error?: string; notice?: string;
  history: DocumentCommand[]; future: DocumentCommand[];
  pendingEdit?: PendingEdit;
  commit(name: string, mutate: (m: ProjectModel) => ProjectModel, scenarioId?: string): boolean;
  requestEdit(name: string, mutate: (m: ProjectModel) => ProjectModel): boolean;
  finishEdit(selectedIds?: string[]): void;
  updateActivityPatches(patches: { id: string; patch: Partial<Activity> }[]): boolean;
  pasteActivities(records: Record<string, string>[]): boolean;
  load(m: ProjectModel, path?: string): void; saveCompleted(revision: number, path?: string, notify?: boolean): void;
  updateEntity(type: EntityType, id: string, patch: Record<string, unknown>): void; setTagCatalog(tags: string[]): boolean;
  updateActivities(ids: string[], patch: Partial<Activity>): void;
  addActivity(milestone?: boolean, graphPosition?: Activity['graphPosition']): void; duplicateSelection(): void; deleteSelection(): void;
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
  requestEdit: (name, mutate) => {
    try {
      const state = get();
      if (state.pendingEdit) throw new Error('Complete or cancel the pending duration proposal first.');
      const original = toModel(state.document), before = resolveScenario(original, state.activeScenarioId);
      const model = mutate(structuredClone(original));
      validateDocument(model);
      const after = resolveScenario(model, state.activeScenarioId);
      const changedCalendars = before.calendars.filter(c => {
        const updated = after.calendars.find(x => x.id === c.id);
        return updated && JSON.stringify(c) !== JSON.stringify(updated);
      });
      const basis = (activity: Activity, snapshot: typeof before) => {
        const owner = snapshot.project.team?.members.find(m => m.id === activity.ownerId);
        const calendarId = owner ? snapshot.project.team!.calendarId : snapshot.project.defaultCalendarId;
        return JSON.stringify([owner?.allocationPercent ?? 100, snapshot.calendars.find(c => c.id === calendarId)]);
      };
      const proposals = after.activities.flatMap(activity => {
        const previous = before.activities.find(a => a.id === activity.id);
        const previousCalendar = previous?.calendarId ?? before.project.defaultCalendarId;
        const calendarChanged = changedCalendars.some(c => c.id === previousCalendar)
          || (!previous?.calendarId && before.project.defaultCalendarId !== after.project.defaultCalendarId);
        if (!previous || (previous.effortHours === activity.effortHours && previous.ownerId === activity.ownerId
          && !calendarChanged && basis(previous, before) === basis(activity, after))) return [];
        return [proposeDuration(after, activity)];
      });
      if (before.project.defaultCalendarId !== after.project.defaultCalendarId) {
        for (const activity of before.activities.filter(a => !a.calendarId)) {
          if (state.activeScenarioId) writeOverride(model, state.activeScenarioId, 'activity', activity.id, 'calendarId', before.project.defaultCalendarId);
          else model.activities.find(a => a.id === activity.id)!.calendarId = before.project.defaultCalendarId;
        }
      }
      for (const oldCalendar of changedCalendars) {
        const frozen = { ...structuredClone(oldCalendar), id: crypto.randomUUID(), name: `${oldCalendar.name} (previous)` };
        const affected = before.activities.filter(a => (a.calendarId ?? before.project.defaultCalendarId) === oldCalendar.id);
        if (!affected.length) continue;
        if (state.activeScenarioId) writeOverride(model, state.activeScenarioId, 'calendar', frozen.id, '$entity', frozen);
        else model.calendars.push(frozen);
        for (const activity of affected) {
          if (state.activeScenarioId) writeOverride(model, state.activeScenarioId, 'activity', activity.id, 'calendarId', frozen.id);
          else model.activities.find(a => a.id === activity.id)!.calendarId = frozen.id;
        }
      }
      validateDocument(model);
      if (!proposals.length) return get().commit(name, () => model);
      set({ pendingEdit: { name, model, revision: state.revision, scenarioId: state.activeScenarioId, proposals }, error: undefined });
      return true;
    } catch (error) { get().report(error); return false; }
  },
  finishEdit: selectedIds => {
    const state = get(), pending = state.pendingEdit;
    if (!pending) return;
    if (!selectedIds) { set({ pendingEdit: undefined }); return; }
    if (pending.revision !== state.revision || pending.scenarioId !== state.activeScenarioId) {
      set({ pendingEdit: undefined }); get().report('The project changed while the proposal was open. Please retry.'); return;
    }
    const selected = new Set(selectedIds);
    const model = structuredClone(pending.model);
    for (const proposal of pending.proposals) {
      if (!selected.has(proposal.activityId) || proposal.duration === undefined || !proposal.calendarId) continue;
      if (pending.scenarioId) {
        writeOverride(model, pending.scenarioId, 'activity', proposal.activityId, 'duration', proposal.duration);
        writeOverride(model, pending.scenarioId, 'activity', proposal.activityId, 'calendarId', proposal.calendarId);
      } else {
        const activity = model.activities.find(a => a.id === proposal.activityId)!;
        activity.duration = proposal.duration; activity.calendarId = proposal.calendarId;
      }
    }
    if (get().commit(pending.name, () => model, pending.scenarioId)) set({ pendingEdit: undefined });
  },
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
      const normalized = parseProject(m);
      validateDocument(normalized);
      set(s => ({ document: normalize(normalized), revision: s.revision + 1, dirty: false, path, activeScenarioId: undefined,
        selectedActivityIds: [], selectedDependencyId: undefined, activeMilestoneId: undefined, history: [], future: [],
        pendingEdit: undefined, results: undefined, comparison: undefined, error: undefined, calculationStatus: 'calculating' }));
    } catch (error) { get().report(error); }
  },
  saveCompleted: (revision, path, notify = true) => set(s => ({
    dirty: s.revision !== revision, path: path ?? s.path, ...(notify ? { notice: 'Project saved locally.' } : {}),
  })),
  updateEntity: (type, id, patch) => {
    const apply = type === 'calendar' || (type === 'project' && ('team' in patch || 'defaultCalendarId' in patch)) ? get().requestEdit : get().commit;
    apply(`Update ${type}`, m => {
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
  setTagCatalog: tags => {
    const state = get(), catalog = tags.map(tag => tag.trim()), keys = catalog.map(tag => tag.toLocaleLowerCase());
    if (catalog.some(tag => !tag || tag.includes(',')) || new Set(keys).size !== keys.length) {
      get().report('Tag names must be non-empty, comma-free and unique.');
      return false;
    }
    return get().commit('Update tag catalog', model => {
      const resolved = resolveScenario(model, state.activeScenarioId);
      const canonicalTags = new Map(catalog.map(tag => [tag.toLocaleLowerCase(), tag]));
      const normalizeTags = (activity: Activity) => (activity.tags ?? []).flatMap(tag => {
        const canonical = canonicalTags.get(tag.toLocaleLowerCase());
        return canonical ? [canonical] : [];
      });
      if (state.activeScenarioId) {
        writeOverride(model, state.activeScenarioId, 'project', model.project.id, 'tagCatalog', catalog);
        for (const activity of resolved.activities.filter(a => a.type === 'TASK' && JSON.stringify(a.tags ?? []) !== JSON.stringify(normalizeTags(a)))) {
          const tags = normalizeTags(activity);
          writeOverride(model, state.activeScenarioId, 'activity', activity.id, 'tags', tags.length ? tags : undefined);
        }
      } else {
        model.project.tagCatalog = catalog;
        for (const activity of model.activities.filter(a => a.type === 'TASK' && JSON.stringify(a.tags ?? []) !== JSON.stringify(normalizeTags(a)))) {
          const tags = normalizeTags(activity);
          activity.tags = tags.length ? tags : undefined;
        }
      }
      return model;
    }, state.activeScenarioId);
  },
  updateActivities: (ids, patch) => {
    get().updateActivityPatches(ids.map(id => ({ id, patch })));
  },
  updateActivityPatches: patches => {
    return get().requestEdit('Edit activities', m => {
      for (const { id, patch } of patches) {
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
  pasteActivities: records => {
    const state = get();
    return state.requestEdit('Paste activities', model => {
      if (!records.length) throw new Error('TSV requires at least one activity row.');
      const resolved = resolveScenario(model, state.activeScenarioId);
      const seen = new Set<string>();
      let created = 0;
      for (const record of records) {
        const headers = Object.keys(record);
        if (!headers.includes('code') || headers.some(field => !editableActivityFields.has(field)))
          throw new Error('TSV requires code and editable activity field headers.');
        const code = record.code;
        if (!code?.trim()) throw new Error('Activity code is required.');
        if (seen.has(code)) throw new Error(`Duplicate activity code in TSV: ${code}`);
        seen.add(code);
        const matches = resolved.activities.filter(activity => activity.code === code);
        if (matches.length > 1) throw new Error(`Activity code is ambiguous: ${code}`);
        const existing = matches[0];
        if (!existing && !record.name?.trim()) throw new Error(`New activity ${code} requires name.`);
        const activity = existing ?? createActivity(resolved.project.id, resolved.activities.length + ++created);
        const patch: Partial<Activity> = {};
        for (const field of headers) {
          if (field !== 'code') Object.assign(patch, activityPatch(field, record[field], activity, resolved.project.projectStart));
        }
        if (existing) {
          if (state.activeScenarioId) {
            for (const [field, value] of Object.entries(patch)) writeOverride(model, state.activeScenarioId, 'activity', activity.id, field, value);
          } else Object.assign(model.activities.find(a => a.id === activity.id)!, patch);
        } else {
          Object.assign(activity, patch, { code });
          if (state.activeScenarioId) writeOverride(model, state.activeScenarioId, 'activity', activity.id, '$entity', activity);
          else model.activities.push(activity);
        }
      }
      return model;
    });
  },
  addActivity: (milestone = false, graphPosition) => {
    const state = get(), resolved = resolveScenario(toModel(state.document), state.activeScenarioId);
    const a = createActivity(resolved.project.id, resolved.activities.length + 1, milestone);
    if (graphPosition) a.graphPosition = graphPosition;
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
