import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createActivity, parseProject, type Activity, type Dependency, type ProjectModel } from '@planner/domain';
import { resolveScenario, validateDocument, writeOverride } from '@planner/scenarios';
import { createProjectEngine, normalize, toModel, command } from '../../../packages/application/src/index';
import { batchSchema, commandSchema, ServiceError, type PlannerCommand, type ChangeBatch } from './contracts';
import { FileProjectRepository, type Approval, type ProjectRecord, type SavedCommand } from './repository';

type Engine = ReturnType<typeof createProjectEngine>;
export type Actor = 'ui' | 'agent';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const string = z.string().min(1);
const patch = z.record(z.string(), z.unknown());
const activityFields = new Set(['code', 'name', 'description', 'type', 'effortHours', 'duration', 'durationUnit',
  'elapsedMode', 'scheduleMode', 'plannedStart', 'plannedFinish', 'actualStart', 'actualFinish', 'constraintType',
  'constraintDate', 'targetDate', 'intrinsicRisk', 'probabilityOfDelay', 'delayP80', 'calendarId', 'ownerId', 'status', 'graphPosition', 'tags']);
const dependencyFields = new Set(['predecessorId', 'successorId', 'type', 'lag', 'lagUnit', 'edgeWeight']);
function describeChanges(before: ProjectModel, after: ProjectModel, scenarioId?: string, resultingScenarioId?: string) {
  const first = resolveScenario(before, scenarioId), last = resolveScenario(after, resultingScenarioId);
  const diff: { target: string; id: string; before?: unknown; after?: unknown }[] = [];
  const compare = (target: string, a: { id: string }[], b: { id: string }[]) => {
    const ids = new Set([...a, ...b].map(item => item.id));
    for (const id of ids) {
      const previous = a.find(item => item.id === id), current = b.find(item => item.id === id);
      if (JSON.stringify(previous) !== JSON.stringify(current)) diff.push({ target, id, before: previous, after: current });
    }
  };
  compare('activity', first.activities, last.activities);
  compare('dependency', first.dependencies, last.dependencies);
  compare('calendar', first.calendars, last.calendars);
  compare('scenario', before.scenarios, after.scenarios);
  compare('baseline', before.baselines.map(item => ({ id: item.id, name: item.name })), after.baselines.map(item => ({ id: item.id, name: item.name })));
  if (JSON.stringify(first.project) !== JSON.stringify(last.project)) diff.push({ target: 'project', id: first.project.id, before: first.project, after: last.project });
  if (JSON.stringify(first.settings) !== JSON.stringify(last.settings)) diff.push({ target: 'settings', id: 'risk', before: first.settings, after: last.settings });
  return diff;
}
function safePatch(value: Record<string, unknown>, fields: Set<string>) {
  if (Object.keys(value).some(key => !fields.has(key))) throw new ServiceError(400, 'INVALID_FIELD', 'Patch includes a read-only or unknown field.');
}
function applyBatch(engine: Engine, batch: ChangeBatch, scenarioId?: string) {
  engine.getState().requestEdit('Apply MCP changes', model => {
    const resolved = resolveScenario(model, scenarioId);
    for (const [index, edit] of (batch.activities ?? []).entries()) {
      safePatch(edit.patch, activityFields);
      if (!edit.id && (typeof edit.patch.code !== 'string' || typeof edit.patch.name !== 'string'))
        throw new Error('New activities require code and name.');
      const current = edit.id ? resolved.activities.find(a => a.id === edit.id) : undefined;
      if (edit.id && !current) throw new Error('Activity not found.');
      const activity = current ?? createActivity(model.project.id, resolved.activities.length + index + 1);
      if (!current && resolved.activities.some(a => a.code === edit.patch.code)) throw new Error('New activity code already exists.');
      if (scenarioId) {
        if (current) for (const [key, value] of Object.entries(edit.patch)) writeOverride(model, scenarioId, 'activity', activity.id, key, value);
        else writeOverride(model, scenarioId, 'activity', activity.id, '$entity', { ...activity, ...edit.patch });
      } else if (current) Object.assign(model.activities.find(a => a.id === activity.id)!, edit.patch);
      else model.activities.push({ ...activity, ...edit.patch });
    }
    for (const edit of batch.dependencies ?? []) {
      safePatch(edit.patch, dependencyFields);
      const current = edit.id ? resolved.dependencies.find(d => d.id === edit.id) : undefined;
      if (edit.id && !current) throw new Error('Dependency not found.');
      const endpoints = current ? undefined : z.object({ predecessorId: string, successorId: string }).parse(edit.patch);
      const dependency: Dependency = current ?? { id: randomUUID(), projectId: model.project.id,
        predecessorId: endpoints!.predecessorId, successorId: endpoints!.successorId, type: 'FS', lag: 0, lagUnit: 'd' };
      if (scenarioId) {
        if (current) for (const [key, value] of Object.entries(edit.patch)) writeOverride(model, scenarioId, 'dependency', dependency.id, key, value);
        else writeOverride(model, scenarioId, 'dependency', dependency.id, '$entity', { ...dependency, ...edit.patch });
      } else if (current) Object.assign(model.dependencies.find(d => d.id === dependency.id)!, edit.patch);
      else model.dependencies.push({ ...dependency, ...edit.patch });
    }
    const updated = resolveScenario(model, scenarioId);
    if (new Set(updated.activities.map(activity => activity.code)).size !== updated.activities.length)
      throw new Error('Activity codes must be unique in a change batch.');
    return model;
  });
}
export function restore(record: ProjectRecord): Engine {
  const engine = createProjectEngine();
  engine.getState().load(record.model);
  const hydrate = (entry: SavedCommand) => command(entry.name, normalize(entry.before), normalize(entry.after), entry.beforeScenarioId, entry.afterScenarioId);
  engine.setState({ revision: record.revision, dirty: record.dirty, activeScenarioId: record.activeScenarioId,
    pendingEdit: record.pendingEdit, history: record.history.map(hydrate), future: record.future.map(hydrate), error: undefined });
  return engine;
}
function serialize(engine: Engine, record: ProjectRecord): ProjectRecord {
  const state = engine.getState();
  const entries = (commands: typeof state.history) => commands.map(entry => ({
    name: entry.name, before: toModel(entry.undo()), after: toModel(entry.execute()),
    beforeScenarioId: entry.beforeScenarioId, afterScenarioId: entry.afterScenarioId,
  }));
  const pendingEdit = state.pendingEdit
    ? { ...state.pendingEdit, id: state.pendingEdit.id ?? randomUUID() } : undefined;
  return { ...record, model: toModel(state.document), dirty: state.dirty, activeScenarioId: state.activeScenarioId,
    pendingEdit, history: entries(state.history), future: entries(state.future) };
}
export function snapshot(record: ProjectRecord) {
  const preservesBaselines = (model: ProjectModel | undefined) => !!model && record.model.baselines.every(baseline =>
    JSON.stringify(model.baselines.find(item => item.id === baseline.id)) === JSON.stringify(baseline));
  return { model: record.model, revision: record.revision, dirty: record.dirty,
    activeScenarioId: record.activeScenarioId, pendingEdit: record.pendingEdit,
    canUndo: preservesBaselines(record.history.at(-1)?.before), canRedo: preservesBaselines(record.future.at(-1)?.after) };
}
export function dispatch(engine: Engine, input: PlannerCommand, actor: Actor) {
  const state = engine.getState();
  const immutableSnapshots = toModel(state.document).baselines;
  if (input.scenarioId && !toModel(state.document).scenarios.some(scenario => scenario.id === input.scenarioId))
    throw new ServiceError(404, 'SCENARIO_NOT_FOUND', 'Scenario not found.');
  if (state.pendingEdit && input.action !== 'finishEdit')
    throw new ServiceError(409, 'PENDING_DURATION', 'Resolve the pending duration proposal first.');
  if (input.action === 'finishEdit' && state.pendingEdit?.scenarioId !== input.scenarioId)
    throw new ServiceError(409, 'SCENARIO_MISMATCH', 'The duration proposal belongs to another scenario.');
  engine.setState({ activeScenarioId: input.scenarioId, selectedActivityIds: input.selection?.activityIds ?? [],
    selectedDependencyId: input.selection?.dependencyId, error: undefined });
  const s = engine.getState(), args = input.args.map(value => value === null ? undefined : value);
  const current = resolveScenario(toModel(s.document), input.scenarioId);
  const baseline = input.scenarioId && toModel(s.document).scenarios.find(item => item.id === input.scenarioId)?.isBaseline;
  if (baseline && !['newScenario', 'baseline', 'manageBaseline', 'saveCompleted'].includes(input.action))
    throw new ServiceError(403, 'IMMUTABLE_BASELINE', 'Published baselines are read-only.');
  switch (input.action) {
    case 'manageBaseline': {
      const [id, action, name] = z.tuple([string, z.enum(['delete', 'archive', 'restore']), string]).parse(args);
      s.manageBaseline(id, action, name);
      break;
    }
    case 'replaceDocument': {
      if (actor !== 'ui') throw new ServiceError(403, 'FORBIDDEN', 'Document replacement is only available to the interactive UI.');
      const replacement = parseProject(args[0]);
      const original = toModel(s.document);
      if (replacement.project.id !== original.project.id) throw new ServiceError(400, 'PROJECT_MISMATCH', 'Cannot replace another project.');
      if (JSON.stringify(replacement.baselines) !== JSON.stringify(original.baselines)
        || JSON.stringify(replacement.scenarios.filter(item => item.isBaseline)) !== JSON.stringify(original.scenarios.filter(item => item.isBaseline)))
        throw new ServiceError(403, 'IMMUTABLE_BASELINE', 'Use publication commands; existing baselines cannot be replaced.');
      s.requestEdit(z.string().max(120).parse(args[1] ?? 'Edit project'), () => replacement);
      break;
    }
    case 'applyChanges': applyBatch(engine, batchSchema.parse(args[0]), input.scenarioId); break;
    case 'updateActivityPatches': {
      const [edits] = z.tuple([z.array(z.object({ id: string, patch })).max(1000)]).parse(args);
      edits.forEach(edit => safePatch(edit.patch, activityFields));
      s.updateActivityPatches(edits); break;
    }
    case 'updateActivities': {
      const [ids, changes] = z.tuple([z.array(string).max(1000), patch]).parse(args);
      safePatch(changes, activityFields); s.updateActivities(ids, changes); break;
    }
    case 'updateEntity': {
      const [entityType, id, changes] = z.tuple([z.enum(['activity', 'dependency', 'project', 'settings', 'calendar']), string, patch]).parse(args);
      const allowed = entityType === 'activity' ? activityFields : entityType === 'dependency' ? dependencyFields
        : new Set(entityType === 'project' ? ['name', 'description', 'projectStart', 'targetFinish', 'defaultCalendarId', 'team', 'tagCatalog']
          : entityType === 'calendar' ? ['name', 'workingDays', 'workingIntervals', 'holidays', 'exceptions']
            : ['riskThreshold', 'defaultDamping', 'transmissionCap', 'defaultImpactHorizon', 'riskColorThresholds']);
      safePatch(changes, allowed); s.updateEntity(entityType, id, changes); break;
    }
    case 'pasteActivities': s.pasteActivities(z.tuple([z.array(z.record(z.string(), z.string())).max(1000)]).parse(args)[0]); break;
    case 'setTagCatalog': s.setTagCatalog(z.tuple([z.array(z.string()).max(1000)]).parse(args)[0]); break;
    case 'upsertCalendar': {
      const interval = z.object({ start: string, end: string }).strict();
      const [calendar] = z.tuple([z.object({
        id: string, name: string, workingDays: z.array(z.number().int()).max(7),
        workingIntervals: z.array(interval).max(100), holidays: z.array(string).max(1000),
        exceptions: z.array(z.object({ date: string, intervals: z.array(interval).max(100) }).strict()).max(1000),
      }).strict()]).parse(args);
      if (current.calendars.some(item => item.id === calendar.id)) {
        const { id, ...changes } = calendar;
        s.updateEntity('calendar', id, changes);
      } else {
        s.requestEdit('Create calendar', model => {
          if (input.scenarioId) writeOverride(model, input.scenarioId, 'calendar', calendar.id, '$entity', calendar);
          else model.calendars.push(calendar);
          return model;
        });
      }
      break;
    }
    case 'addActivity': {
      const [milestone, position] = z.tuple([z.boolean().optional(), z.object({ x: z.number(), y: z.number() }).optional()]).parse([args[0], args[1]]);
      s.addActivity(milestone, position); break;
    }
    case 'duplicateSelection': s.duplicateSelection(); break;
    case 'deleteSelection': {
      if (input.selection?.activityIds.some(id => !current.activities.some(a => a.id === id)))
        throw new ServiceError(422, 'ACTIVITY_NOT_FOUND', 'Activity selected for deletion does not exist.');
      s.deleteSelection(); break;
    }
    case 'connect': {
      const [from, to, type, lag, unit] = z.tuple([string, string, z.enum(['FS', 'SS', 'FF', 'SF']).optional(), z.number().optional(), z.enum(['d', 'h']).optional()])
        .parse([args[0], args[1], args[2], args[3], args[4]]);
      s.connect(from, to, type, lag, unit); break;
    }
    case 'newScenario': {
      const [name, clone] = z.tuple([string, z.boolean().optional()]).parse([args[0], args[1]]);
      s.newScenario(name, clone); break;
    }
    case 'renameScenario': s.renameScenario(z.tuple([string]).parse(args)[0]); break;
    case 'removeScenario': s.removeScenario(); break;
    case 'baseline': s.baseline(z.tuple([string]).parse(args)[0]); break;
    case 'finishEdit': {
      const [selectedIds, proposalId] = z.tuple([z.array(string).optional(), string.optional()]).parse([args[0], args[1]]);
      if (actor === 'agent') {
        if (!s.pendingEdit || !proposalId || proposalId !== s.pendingEdit.id)
          throw new ServiceError(409, 'PROPOSAL_MISMATCH', 'The duration proposal is missing or has changed.');
        if (selectedIds?.some(id => !s.pendingEdit!.proposals.some(proposal => proposal.activityId === id && proposal.duration !== undefined && proposal.calendarId)))
          throw new ServiceError(422, 'INVALID_PROPOSAL_SELECTION', 'Selected activities must have applicable duration proposals.');
      }
      s.finishEdit(selectedIds); break;
    }
    case 'undo': s.undo(); break;
    case 'redo': s.redo(); break;
    case 'saveCompleted':
      if (actor !== 'ui') throw new ServiceError(403, 'FORBIDDEN', 'Only the UI may mark an export saved.');
      s.saveCompleted(s.revision, undefined, false); break;
  }
  if (engine.getState().error) throw new ServiceError(422, 'VALIDATION', engine.getState().error!);
  const next = toModel(engine.getState().document);
  const allowedRemoval = input.action === 'manageBaseline' && args[1] === 'delete' ? args[0] : undefined;
  if (immutableSnapshots.some(baseline => {
    const updated = next.baselines.find(item => item.id === baseline.id);
    if (!updated) return baseline.id !== allowedRemoval;
    return JSON.stringify({ ...updated, archived: undefined }) !== JSON.stringify({ ...baseline, archived: undefined });
  }))
    throw new ServiceError(403, 'IMMUTABLE_BASELINE', 'Published baselines cannot be changed or removed, including through Undo.');
  validateDocument(next);
}

export class PlannerService {
  private queues = new Map<string, Promise<unknown>>();
  private listeners = new Map<string, Set<(revision: number) => void>>();
  readonly repository: FileProjectRepository;
  constructor(repository: FileProjectRepository) { this.repository = repository; }
  private exclusive<T>(id: string, run: () => Promise<T>): Promise<T> {
    const before = this.queues.get(id) ?? Promise.resolve();
    const next = before.catch(() => undefined).then(run);
    this.queues.set(id, next);
    void next.finally(() => { if (this.queues.get(id) === next) this.queues.delete(id); }).catch(() => undefined);
    return next;
  }
  async get(id: string) {
    const record = await this.repository.read(id);
    if (!record) throw new ServiceError(404, 'NOT_FOUND', 'Project not found.');
    return record;
  }
  subscribe(id: string, listener: (revision: number) => void) {
    const list = this.listeners.get(id) ?? new Set();
    list.add(listener); this.listeners.set(id, list);
    return () => { list.delete(listener); if (!list.size) this.listeners.delete(id); };
  }
  private async persist(record: ProjectRecord) {
    await this.repository.write(record);
    for (const listener of this.listeners.get(record.model.project.id) ?? []) listener(record.revision);
  }
  register(model: ProjectModel) {
    const normalized = parseProject(model); validateDocument(normalized);
    return this.exclusive(normalized.project.id, async () => {
      const existing = await this.repository.read(normalized.project.id);
      if (existing) return snapshot(existing);
      const record: ProjectRecord = { model: normalized, revision: 0, dirty: false, history: [], future: [], approvals: [], audit: [], operations: [] };
      await this.persist(record); return snapshot(record);
    });
  }
  registerImport(model: ProjectModel, importId: string) {
    const normalized = parseProject(model); validateDocument(normalized);
    return this.exclusive(normalized.project.id, async () => {
      const existing = await this.repository.read(normalized.project.id);
      if (existing) {
        if (existing.importId === importId) return snapshot(existing);
        throw new ServiceError(409, 'PROJECT_EXISTS', 'A project with this ID already exists.');
      }
      const record: ProjectRecord = { model: normalized, importId, revision: 0, dirty: false,
        history: [], future: [], approvals: [], audit: [], operations: [] };
      await this.persist(record); return snapshot(record);
    });
  }
  preview(id: string, raw: unknown, actor: Actor) {
    return this.exclusive(id, async () => {
      const input = commandSchema.parse(raw), record = await this.get(id);
      if (input.expectedRevision !== record.revision) throw new ServiceError(409, 'REVISION_CONFLICT', 'Project changed. Reload and retry with its current revision.');
      const engine = restore(record); dispatch(engine, input, actor);
      const result = serialize(engine, record);
      return { ...snapshot(result), preview: true, payloadHash: hash(input), requiresApproval: this.sensitive(input, record, actor),
        diff: describeChanges(record.model, result.pendingEdit?.model ?? result.model, input.scenarioId, result.activeScenarioId) };
    });
  }
  private sensitive(input: PlannerCommand, record: ProjectRecord, actor: Actor) {
    if (actor === 'ui') return false;
    if (['baseline', 'manageBaseline', 'deleteSelection', 'removeScenario', 'undo', 'redo'].includes(input.action)) return true;
    if (input.action === 'newScenario') return !input.args[1] && !record.model.baselines.some(b => !b.archived);
    const current = resolveScenario(record.model, input.scenarioId);
    if (input.action === 'setTagCatalog') {
      const tags = z.array(z.string()).parse(input.args[0]).map(tag => tag.trim().toLocaleLowerCase());
      if ((current.project.tagCatalog ?? []).some(tag => !tags.includes(tag.toLocaleLowerCase()))) return true;
    }
    if (input.action === 'updateEntity' && input.args[0] === 'project') {
      const changes = patch.parse(input.args[2]);
      if (changes.tagCatalog !== undefined) {
        const tags = z.array(z.string()).parse(changes.tagCatalog).map(tag => tag.trim().toLocaleLowerCase());
        if ((current.project.tagCatalog ?? []).some(tag => !tags.includes(tag.toLocaleLowerCase()))) return true;
      }
      if (changes.team !== undefined) {
        const team = z.object({ members: z.array(z.object({ id: string }).passthrough()) }).passthrough().parse(changes.team);
        if ((current.project.team?.members ?? []).some(member => !team.members.some(item => item.id === member.id))) return true;
      }
    }
    return !input.scenarioId || (input.action === 'finishEdit' && !record.pendingEdit?.scenarioId);
  }
  execute(id: string, raw: unknown, actor: Actor) {
    return this.exclusive(id, async () => {
      const input = commandSchema.parse(raw), record = await this.get(id), digest = hash(input);
      const retried = record.operations.find(operation => operation.id === input.operationId);
      if (retried) {
        if (retried.hash !== digest || retried.actor !== actor) throw new ServiceError(409, 'OPERATION_ID_REUSED', 'Operation ID already used with a different payload or actor.');
        if (retried.approvalId) {
          const approval = record.approvals.find(op => op.id === retried.approvalId);
          if (!approval) throw new ServiceError(409, 'OPERATION_EXPIRED', 'Operation history expired. Reload the current project.');
          if (approval.status === 'pending' && Date.parse(approval.expiresAt) < Date.now()) {
            approval.status = 'expired';
            record.audit = [...record.audit, { at: new Date().toISOString(), actor: 'system', action: approval.action,
              revision: record.revision, operationId: input.operationId, outcome: 'expired' }].slice(-1000);
            await this.persist(record);
          }
          return { ...snapshot(record), status: approval.status === 'pending' ? 'approval_required' : approval.status, operation: approval, replayed: true };
        }
        return { ...snapshot(record), appliedRevision: retried.revision, replayed: true };
      }
      if (record.revision !== input.expectedRevision) throw new ServiceError(409, 'REVISION_CONFLICT', 'Project changed. Reload and retry with its current revision.');
      const engine = restore(record); dispatch(engine, input, actor);
      if (this.sensitive(input, record, actor)) {
        const approval: Approval = { id: randomUUID(), status: 'pending', action: input.action, args: input.args, scenarioId: input.scenarioId,
          expectedRevision: record.revision, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), payloadHash: digest, command: input,
          diff: describeChanges(record.model, engine.getState().pendingEdit?.model ?? toModel(engine.getState().document), input.scenarioId, engine.getState().activeScenarioId) };
        record.approvals = [...record.approvals, approval].slice(-200);
        record.operations = [...record.operations, { id: input.operationId, hash: digest, actor, revision: record.revision, approvalId: approval.id }].slice(-500);
        record.audit = [...record.audit, { at: new Date().toISOString(), actor, action: input.action, revision: record.revision, operationId: input.operationId, outcome: 'approval_required' }].slice(-1000);
        await this.persist(record);
        return { status: 'approval_required', operation: approval };
      }
      const next = serialize(engine, record);
      next.revision = record.revision + 1;
      if (next.pendingEdit) next.pendingEdit.revision = next.revision;
      next.operations = [...record.operations, { id: input.operationId, hash: digest, actor, revision: next.revision }].slice(-500);
      next.audit = [...record.audit, { at: new Date().toISOString(), actor, action: input.action, revision: next.revision, operationId: input.operationId, outcome: next.pendingEdit ? 'duration_proposal' : 'committed' }].slice(-1000);
      await this.persist(next); return snapshot(next);
    });
  }
  recordCommandFailure(id: string, raw: unknown, actor: Actor, error: unknown) {
    const envelope = z.object({ action: commandSchema.shape.action.optional(),
      operationId: z.string().min(1).max(128).optional() }).safeParse(raw);
    const action = envelope.success ? envelope.data.action ?? 'invalid_command' : 'invalid_command';
    const operationId = envelope.success ? envelope.data.operationId ?? randomUUID() : randomUUID();
    return this.exclusive(id, async () => {
      const record = await this.repository.read(id);
      if (!record) return;
      const outcome = error instanceof ServiceError ? `failed:${error.code}` : error instanceof z.ZodError
        ? 'failed:INVALID_INPUT' : 'failed:INTERNAL_ERROR';
      record.audit = [...record.audit, { at: new Date().toISOString(), actor, action,
        revision: record.revision, operationId, outcome }].slice(-1000);
      await this.persist(record);
    });
  }
  expireApprovals(id: string) {
    return this.exclusive(id, async () => {
      const record = await this.get(id);
      const expired = record.approvals.filter(approval => approval.status === 'pending' && Date.parse(approval.expiresAt) < Date.now());
      if (expired.length) {
        for (const approval of expired) {
          approval.status = 'expired';
          record.audit.push({ at: new Date().toISOString(), actor: 'system', action: approval.action,
            revision: record.revision, operationId: approval.command.operationId, outcome: 'expired' });
        }
        record.audit = record.audit.slice(-1000);
        await this.persist(record);
      }
      return record.approvals;
    });
  }
  decide(id: string, approvalId: string, approve: boolean) {
    return this.exclusive(id, async () => {
      const record = await this.get(id), approval = record.approvals.find(op => op.id === approvalId);
      if (!approval) throw new ServiceError(404, 'NOT_FOUND', 'Approval not found.');
      if (approval.status !== 'pending') throw new ServiceError(409, 'APPROVAL_USED', 'Approval already processed.');
      if (Date.parse(approval.expiresAt) < Date.now()) approval.status = 'expired';
      else if (!approve) approval.status = 'rejected';
      else if (record.revision !== approval.expectedRevision) approval.status = 'conflict';
      else {
        if (hash(approval.command) !== approval.payloadHash) throw new ServiceError(409, 'PAYLOAD_CHANGED', 'Approval payload changed.');
        const engine = restore(record); dispatch(engine, approval.command, 'agent');
        const next = serialize(engine, record);
        approval.status = 'approved';
        next.revision = record.revision + 1;
        if (next.pendingEdit) next.pendingEdit.revision = next.revision;
        next.audit = [...record.audit, { at: new Date().toISOString(), actor: 'ui', action: approval.action, revision: next.revision, operationId: approval.command.operationId, outcome: 'approved' }].slice(-1000);
        await this.persist(next);
        return { operation: approval, ...snapshot(next) };
      }
      record.audit = [...record.audit, { at: new Date().toISOString(), actor: 'ui', action: approval.action,
        revision: record.revision, operationId: approval.command.operationId, outcome: approval.status }].slice(-1000);
      await this.persist(record);
      return { operation: approval, ...snapshot(record) };
    });
  }
}
