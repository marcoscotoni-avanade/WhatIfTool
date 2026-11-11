import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { resolveScenario } from '@planner/scenarios';
import type { ProjectModel } from '@planner/domain';
import { PlannerHttpError, type PlannerClient, type CommandRequest, type ProjectResponse } from './client';

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

type ToolHandler = (input: any) => Promise<unknown>;

export function registerPlannerTools(server: McpServer, planner: PlannerClient): void {
  const register = (name: string, description: string, schema: z.ZodType, handler: ToolHandler, annotations?: Record<string, unknown>) => {
    server.registerTool(name, {
      description,
      inputSchema: schema,
      outputSchema,
      annotations,
    }, async input => {
      try {
        const data = await handler(input);
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

  register('list_activities', 'List a page of activities for an explicit scenario, or null for the base project.', z.object({
    ...projectIdInput, ...scenarioInput, ...pageInput,
  }).strict(), async ({ projectId, scenarioId, limit, offset }) => {
    const project = await planner.getProject(projectId);
    const model = modelOf(project);
    const snapshot = resolveScenario(model, scenarioId ?? undefined);
    return {
      items: snapshot.activities.slice(offset, offset + limit),
      offset,
      limit,
      total: snapshot.activities.length,
      revision: project.revision,
      scenarioId,
    };
  }, { readOnlyHint: true });

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
  register('create_scenario', 'Create a scenario. Set scenarioId to the explicit source when cloning; pass null when creating from the latest baseline.', createScenarioSchema, async input => {
    const command = commandFor(input, 'newScenario', [input.name, input.clone]);
    const result = await planner.command(input.projectId, command);
    return { result, operationId: input.operationId };
  }, { readOnlyHint: false });

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

  register('apply_changes', 'Apply bounded activity/dependency changes using revision compare-and-swap and an operation id. Sensitive writes may require local UI approval.', previewSchema, async input => {
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
  register('request_delete', 'Request deleting selected activity/dependency ids or removing the explicitly named scenario. Sensitive writes may require local UI approval.', deleteSchema, async input => {
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
