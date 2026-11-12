import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { resolveScenario } from '@planner/scenarios';
import type { ProjectModel } from '@planner/domain';
import { PlannerHttpError, type PlannerClient, type CommandRequest, type ProjectResponse } from './client';
import { activityQuerySchema } from '../../planner-service/src/activity-query';
import { dependencyQuerySchema, diagnosticQuerySchema } from '../../planner-service/src/analysis-query';

const pageInput = {
  limit: z.number().int().min(1).max(100),
  offset: z.number().int().min(0),
};
const projectIdInput = { projectId: z.string().min(1) };
const scenarioInput = { scenarioId: z.string().min(1).nullable() };
const writeInput = {
  ...projectIdInput,
  ...scenarioInput,
  expectedRevision: z.number().int().min(0),
  operationId: z.string().min(1),
};
const outputSchema = z.object({ data: z.unknown() });
const asObject = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Planner service returned an invalid ${label}.`);
  return value as Record<string, unknown>;
};
const modelOf = (project: ProjectResponse): ProjectModel => asObject(project.model, 'project model') as unknown as ProjectModel;
const optionalScenario = (scenarioId: string | null): Pick<CommandRequest, 'scenarioId'> =>
  scenarioId === null ? {} : { scenarioId };
const commandFor = (
  input: z.infer<z.ZodObject<typeof writeInput>>,
  action: string,
  args: unknown,
  selection?: Record<string, unknown>,
): CommandRequest => ({
  expectedRevision: input.expectedRevision,
  operationId: input.operationId,
  action,
  args,
  ...optionalScenario(input.scenarioId),
  ...(selection ? { selection } : {}),
});

export function registerPlannerTools(server: McpServer, planner: PlannerClient): void {
  const register = <T extends z.ZodType>(name: string, description: string, schema: T, handler: (input: z.infer<T>) => Promise<unknown>, annotations?: Record<string, unknown>) => {
    server.registerTool<typeof outputSchema, z.ZodType>(name, {
      description,
      inputSchema: schema,
      outputSchema,
      annotations,
    }, async input => {
      try {
        const data = await handler(schema.parse(input));
        return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: { data } };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const message = error instanceof PlannerHttpError && error.code ? `${error.code}: ${detail}` : detail;
        process.stderr.write(`[mcp] tool ${name} failed\n`);
        return { isError: true, content: [{ type: 'text', text: message }] };
      }
    });
  };

  register('list_projects', 'List a page of planner projects. Pagination is required; the service list is paged in this adapter.', z.object(pageInput).strict(), async ({ limit, offset }) => {
    const projects = await planner.listProjects();
    return { items: projects.slice(offset, offset + limit), offset, limit, total: projects.length };
  }, { readOnlyHint: true });

  register('get_project', 'Get a project model and its current revision/status.', z.object(projectIdInput).strict(), async ({ projectId }) => {
    const project = await planner.getProject(projectId);
    return {
      model: project.model,
      revision: project.revision,
      activeScenarioId: project.activeScenarioId,
      pendingEdit: project.pendingEdit,
      dirty: project.dirty,
      canUndo: project.canUndo,
      canRedo: project.canRedo,
    };
  }, { readOnlyHint: true });

  register('list_activities', 'List activities from an explicit scenario or null for the draft, with optional combined filters. Date bounds are inclusive; tags match exactly.', activityQuerySchema.extend(projectIdInput), async ({ projectId, ...query }) =>
    planner.queryActivities(projectId, query), { readOnlyHint: true });

  register('get_activity', 'Get one activity by id from an explicit scenario, or null for the base project.', z.object({
    ...projectIdInput, ...scenarioInput, activityId: z.string().min(1),
  }).strict(), async ({ projectId, scenarioId, activityId }) => {
    const project = await planner.getProject(projectId);
    const model = modelOf(project);
    const snapshot = resolveScenario(model, scenarioId ?? undefined);
    const activity = snapshot.activities.find(item => item.id === activityId);
    if (!activity) throw new Error(`Activity ${activityId} was not found in project ${projectId}.`);
    return { activity, revision: project.revision, scenarioId };
  }, { readOnlyHint: true });

  register('list_scenarios', 'List project scenarios.', z.object(projectIdInput).strict(), async ({ projectId }) => {
    const project = await planner.getProject(projectId);
    const model = modelOf(project);
    const scenarios = model.scenarios;
    if (!Array.isArray(scenarios)) throw new Error('Planner service returned an invalid scenario list.');
    return { items: scenarios, revision: project.revision };
  }, { readOnlyHint: true });

  const createScenarioSchema = z.object({
    ...projectIdInput,
    ...scenarioInput,
    name: z.string().trim().min(1),
    clone: z.boolean(),
    expectedRevision: z.number().int().min(0),
    operationId: z.string().min(1),
  }).strict().superRefine((input, context) => {
    if (input.clone && !input.scenarioId) {
      context.addIssue({ code: 'custom', path: ['scenarioId'], message: 'scenarioId is required when cloning a scenario.' });
    }
  });
  register('create_scenario', 'Create a scenario. For clone=true, scenarioId is the source: a child inherits subsequent changes from its parent unless overridden. Pass null for a new scenario from the latest active baseline.', createScenarioSchema, async input => {
    const command = commandFor(input, 'newScenario', [input.name, input.clone]);
    const result = await planner.command(input.projectId, command);
    return { result, operationId: input.operationId };
  }, { readOnlyHint: false });

  register('rename_scenario', 'Rename an editable scenario; published baselines cannot be renamed.', z.object({
    ...writeInput, scenarioId: z.string().min(1), name: z.string().trim().min(1),
  }).strict(), async input => {
    const result = await planner.command(input.projectId, commandFor(input, 'renameScenario', [input.name]));
    return { result, operationId: input.operationId, projectId: input.projectId, scenarioId: input.scenarioId };
  }, { readOnlyHint: false });

  register('get_duration_proposal', 'Get the pending duration proposal for an explicit scenario, or null for the draft.', z.object({
    ...projectIdInput, ...scenarioInput,
  }).strict(), async ({ projectId, scenarioId }) => planner.getDurationProposal(projectId, scenarioId), { readOnlyHint: true });

  const durationResolution = z.discriminatedUnion('resolution', [
    z.object({ ...writeInput, proposalId: z.string().min(1), resolution: z.literal('apply_selected'),
      activityIds: z.array(z.string().min(1)).min(1).max(1000) }).strict(),
    z.object({ ...writeInput, proposalId: z.string().min(1), resolution: z.enum(['keep_durations', 'cancel']) }).strict(),
  ]);
  register('resolve_duration_proposal', 'Resolve a matching proposal by applying selected calculated durations, keeping existing durations, or cancelling the pending edit. This applies without UI approval.', durationResolution, async input => {
    const selected = input.resolution === 'apply_selected' ? input.activityIds : input.resolution === 'keep_durations' ? [] : null;
    const result = await planner.command(input.projectId, commandFor(input, 'finishEdit', [selected, input.proposalId]));
    return { result, operationId: input.operationId, projectId: input.projectId, scenarioId: input.scenarioId };
  }, { readOnlyHint: false });

  register('get_team', 'Read the team for an explicit scenario or draft.', z.object({ ...projectIdInput, ...scenarioInput }).strict(),
    async ({ projectId, scenarioId }) => planner.getMetadata(projectId, { scenarioId, kind: 'team' }), { readOnlyHint: true });
  register('get_tag_catalog', 'Read the tag catalog for an explicit scenario or draft.', z.object({ ...projectIdInput, ...scenarioInput }).strict(),
    async ({ projectId, scenarioId }) => planner.getMetadata(projectId, { scenarioId, kind: 'tags' }), { readOnlyHint: true });
  register('list_calendars', 'List a page of calendars for an explicit scenario or draft.', z.object({
    ...projectIdInput, ...scenarioInput, ...pageInput,
  }).strict(), async ({ projectId, ...input }) => planner.getMetadata(projectId, { ...input, kind: 'calendars' }), { readOnlyHint: true });
  register('get_calendar', 'Read a calendar by ID for an explicit scenario or draft.', z.object({
    ...projectIdInput, ...scenarioInput, calendarId: z.string().min(1),
  }).strict(), async ({ projectId, ...input }) => planner.getMetadata(projectId, { ...input, kind: 'calendar' }), { readOnlyHint: true });
  const teamSchema = z.object({ name: z.string().trim().min(1), calendarId: z.string().min(1),
    members: z.array(z.object({ id: z.string().min(1), name: z.string().trim().min(1),
      allocationPercent: z.number().min(0).max(100) }).strict()).max(1000) }).strict();
  register('update_team', 'Replace the team without UI approval. Assigned members cannot be removed. Allocation changes may create duration proposals.', z.object({
    ...writeInput, team: teamSchema,
  }).strict(), async input => {
    const result = await planner.command(input.projectId, commandFor(input, 'updateEntity', ['project', input.projectId, { team: input.team }]));
    return { result, operationId: input.operationId, projectId: input.projectId, scenarioId: input.scenarioId };
  }, { readOnlyHint: false });
  register('set_tag_catalog', 'Replace the tag catalog without UI approval; removed tags are atomically unassigned from tasks.', z.object({
    ...writeInput, tags: z.array(z.string().trim().min(1)).max(1000),
  }).strict(), async input => {
    const result = await planner.command(input.projectId, commandFor(input, 'setTagCatalog', [input.tags]));
    return { result, operationId: input.operationId, projectId: input.projectId, scenarioId: input.scenarioId };
  }, { readOnlyHint: false });
  const intervalSchema = z.object({ start: z.string().min(1), end: z.string().min(1) }).strict();
  register('upsert_calendar', 'Create or update a calendar in the explicit scenario or draft. Updates preserve previous calendars where required and may create duration proposals.', z.object({
    ...writeInput, calendar: z.object({ id: z.string().min(1), name: z.string().min(1), workingDays: z.array(z.number().int()).max(7),
      workingIntervals: z.array(intervalSchema).max(100), holidays: z.array(z.string().min(1)).max(1000),
      exceptions: z.array(z.object({ date: z.string().min(1), intervals: z.array(intervalSchema).max(100) }).strict()).max(1000) }).strict(),
  }).strict(), async input => {
    const result = await planner.command(input.projectId, commandFor(input, 'upsertCalendar', [input.calendar]));
    return { result, operationId: input.operationId, projectId: input.projectId, scenarioId: input.scenarioId };
  }, { readOnlyHint: false });

  const dependencyInput = dependencyQuerySchema.omit({ analyze: true }).extend(projectIdInput);
  register('list_dependencies', 'List dependencies with optional endpoint, type and bounded ancestor/descendant traversal filters.', dependencyInput,
    async ({ projectId, ...input }) => planner.queryAnalysis(projectId, 'dependencies/query', { ...input, analyze: false }), { readOnlyHint: true });
  register('analyze_dependencies', 'List matching dependencies with calculated endpoint slack and critical flags. Multiple critical branches may exist; this is not a single critical path.', dependencyInput,
    async ({ projectId, ...input }) => planner.queryAnalysis(projectId, 'dependencies/query', { ...input, analyze: true }), { readOnlyHint: true });
  register('diagnose_plan', 'Report paginated informational planning diagnostics and schedule violations without modifying the project.', diagnosticQuerySchema.extend(projectIdInput),
    async ({ projectId, ...input }) => planner.queryAnalysis(projectId, 'diagnose', input), { readOnlyHint: true });

  register('list_operation_history', 'List a page of retained project audit events, newest first. Historical events not recorded by earlier versions cannot be recovered.', z.object({
    ...projectIdInput, ...pageInput, from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional(),
    actor: z.enum(['ui', 'agent', 'system']).optional(), action: z.string().min(1).optional(), outcome: z.string().min(1).optional(),
  }).strict().refine(value => !value.from || !value.to || Date.parse(value.from) <= Date.parse(value.to), 'Date bounds are reversed.'),
  async ({ projectId, ...input }) => planner.queryHistory(projectId, input), { readOnlyHint: true });

  register('request_import_project', 'Request importing a structured JSON project. A UI user must approve it before creation; existing project IDs are never overwritten.', z.object({
    operationId: z.string().min(1).max(128), model: z.record(z.string(), z.unknown()),
  }).strict(), async ({ model, operationId }) => planner.requestImport(model, operationId), { readOnlyHint: false });
  register('get_import_status', 'Get the status of an import request by its import ID.', z.object({ importId: z.string().min(1) }).strict(),
    async ({ importId }) => planner.getImport(importId), { readOnlyHint: true });

  register('compare_scenarios', 'Compare a scenario with its baseline, optionally focused on a milestone.', z.object({
    ...projectIdInput, scenarioId: z.string().min(1), milestoneId: z.string().min(1).optional(),
  }).strict(), async ({ projectId, scenarioId, milestoneId }) =>
    planner.compare(projectId, { scenarioId, ...(milestoneId ? { milestoneId } : {}) }), { readOnlyHint: true });

  register('calculate_schedule', 'Calculate schedule and risk results for an explicit scenario, or null for the base project; optionally focus on a milestone.', z.object({
    ...projectIdInput, ...scenarioInput, milestoneId: z.string().min(1).optional(),
  }).strict(), async ({ projectId, scenarioId, milestoneId }) =>
    planner.calculate(projectId, { ...(scenarioId ? { scenarioId } : {}), ...(milestoneId ? { milestoneId } : {}) }), { readOnlyHint: true });

  register('explain_risk', 'Return the risk explanation for one activity in an explicit scenario, or null for the base project.', z.object({
    ...projectIdInput, ...scenarioInput, activityId: z.string().min(1),
  }).strict(), async ({ projectId, scenarioId, activityId }) => {
    const response = asObject(await planner.calculate(projectId, scenarioId ? { scenarioId } : {}), 'calculation response');
    const result = asObject(response.results, 'calculation result');
    const risks = asObject(result.risk, 'risk results');
    const risk = risks[activityId];
    if (!risk) throw new Error(`Risk explanation for activity ${activityId} was not found.`);
    return { activityId, risk, revision: response.revision, scenarioId };
  }, { readOnlyHint: true });

  register('analyze_milestone', 'Analyze schedule and risk contributors for a milestone in an explicit scenario, or null for the base project.', z.object({
    ...projectIdInput, ...scenarioInput, milestoneId: z.string().min(1),
  }).strict(), async ({ projectId, scenarioId, milestoneId }) =>
    planner.calculate(projectId, { ...(scenarioId ? { scenarioId } : {}), milestoneId }), { readOnlyHint: true });

  const changesSchema = z.object({
    activities: z.array(z.object({
      id: z.string().min(1).optional(),
      patch: z.record(z.string(), z.unknown()),
    }).strict()).optional(),
    dependencies: z.array(z.object({
      id: z.string().min(1).optional(),
      patch: z.record(z.string(), z.unknown()),
    }).strict()).optional(),
  }).strict().refine(value => Boolean(value.activities?.length || value.dependencies?.length), {
    message: 'At least one activity or dependency change is required.',
  }).superRefine((value, context) => {
    value.activities?.forEach((item, index) => {
      if (!item.id && (typeof item.patch.code !== 'string' || typeof item.patch.name !== 'string')) {
        context.addIssue({ code: 'custom', path: ['activities', index, 'patch'], message: 'Creating an activity requires code and name.' });
      }
    });
    value.dependencies?.forEach((item, index) => {
      if (!item.id && (typeof item.patch.predecessorId !== 'string' || typeof item.patch.successorId !== 'string')) {
        context.addIssue({ code: 'custom', path: ['dependencies', index, 'patch'], message: 'Creating a dependency requires predecessorId and successorId.' });
      }
    });
  });
  const previewSchema = z.object({
    ...writeInput,
    changes: changesSchema,
  }).strict();
  register('preview_changes', 'Preview bounded activity/dependency changes without persisting them.', previewSchema, async input => {
    const request = commandFor(input, 'applyChanges', [input.changes]);
    return planner.preview(input.projectId, request);
  }, { readOnlyHint: true });

  register('apply_changes', 'Apply bounded activity/dependency changes without UI approval, using revision compare-and-swap and an operation id.', previewSchema, async input => {
    const request = commandFor(input, 'applyChanges', [input.changes]);
    const result = await planner.command(input.projectId, request);
    return { result, operationId: input.operationId };
  }, { readOnlyHint: false });

  register('request_publish_baseline', 'Request publishing a named baseline from the explicit scenario (or base project). Approval, when required, is handled in the local UI.', z.object({
    ...writeInput, name: z.string().trim().min(1),
  }).strict(), async input => {
    const result = await planner.command(input.projectId, commandFor(input, 'baseline', [input.name]));
    return { result, operationId: input.operationId };
  }, { readOnlyHint: false });

  const deleteSchema = z.discriminatedUnion('target', [
    z.object({
      ...writeInput, target: z.literal('selection'),
      selection: z.object({
        activityIds: z.array(z.string().min(1)),
        dependencyId: z.string().min(1).optional(),
      }).strict(),
    }).strict().superRefine((input, context) => {
      if (!input.selection.activityIds.length && !input.selection.dependencyId) {
        context.addIssue({ code: 'custom', path: ['selection'], message: 'At least one activity or dependency id is required.' });
      }
    }),
    z.object({
      ...writeInput, target: z.literal('scenario'), scenarioId: z.string().min(1),
    }).strict(),
  ]);
  register('request_delete', 'Delete selected activity/dependency ids or remove the explicitly named scenario without UI approval.', deleteSchema, async input => {
    const command = input.target === 'scenario'
      ? commandFor(input, 'removeScenario', [])
      : commandFor(input, 'deleteSelection', [], input.selection);
    const result = await planner.command(input.projectId, command);
    return { result, operationId: input.operationId };
  }, { readOnlyHint: false, destructiveHint: true });

  register('request_manage_baseline', 'Request deletion of an unused baseline, or archive/restore a baseline. Referenced baselines cannot be deleted. Requires explicit UI approval; snapshots remain immutable.', z.object({
    ...writeInput, baselineId: z.string().min(1), action: z.enum(['delete', 'archive', 'restore']), confirmationName: z.string().min(1),
  }).strict(), async input => {
    const result = await planner.command(input.projectId, commandFor(input, 'manageBaseline', [input.baselineId, input.action, input.confirmationName]));
    return { result, operationId: input.operationId };
  }, { readOnlyHint: false, destructiveHint: true });

  register('get_operation_status', 'Read an approval operation by its id from a sensitive-write result; this tool does not approve operations.', z.object({
    ...projectIdInput, operationId: z.string().min(1),
  }).strict(), async ({ projectId, operationId }) => planner.getOperation(projectId, operationId), { readOnlyHint: true });

  register('export_project', 'Export a project as JSON. The adapter rejects responses larger than 1 MiB.', z.object(projectIdInput).strict(), async ({ projectId }) => {
    const result = await planner.exportProject(projectId);
    if (JSON.stringify(result).length > 1_048_576) throw new Error('Export exceeds the 1 MiB MCP response limit.');
    return { format: 'json', projectId, data: result };
  }, { readOnlyHint: true });
}
