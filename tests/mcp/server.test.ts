import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProject } from '@planner/domain';
import { createPlannerServer } from '../../apps/planner-service/src/server';

vi.setConfig({ testTimeout: 30_000 });

const model = {
  schemaVersion: 1,
  project: { id: 'p-1', name: 'Test Project' },
  activities: [{ id: 'a-1', projectId: 'p-1', code: 'A1', name: 'Activity 1' }],
  dependencies: [],
  scenarios: [{ id: 's-1', name: 'Scenario 1' }],
  overrides: [],
  baselines: [],
  calendars: [],
  settings: {},
};

const readBody = async (request: IncomingMessage): Promise<any> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
};

describe('MCP server stdio integration', () => {
  let httpServer: ReturnType<typeof createServer> | undefined;
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  let liveServer: Awaited<ReturnType<typeof createPlannerServer>> | undefined;
  let liveDirectory: string | undefined;
  const requests: Array<{ method: string; url: string; body?: any; authorization?: string }> = [];

  afterEach(async () => {
    try {
      await transport?.close();
    } finally {
      try {
        if (httpServer?.listening) {
          await new Promise<void>(resolveClose => httpServer!.close(() => resolveClose()));
        }
      } finally {
        try {
          await liveServer?.close();
        } finally {
          if (liveDirectory) await rm(liveDirectory, { recursive: true, force: true });
          httpServer = undefined;
          client = undefined;
          transport = undefined;
          liveServer = undefined;
          liveDirectory = undefined;
          requests.length = 0;
        }
      }
    }
  });

  it('discovers and invokes tools through the real SDK client with structured results', async () => {
    let failProjectListing = false;
    httpServer = createServer(async (request, response) => {
      const body = await readBody(request);
      requests.push({ method: request.method ?? '', url: request.url ?? '', body, authorization: request.headers.authorization });
      if (request.url === '/api/projects' && failProjectListing) return send(response, 503, { error: 'Service unavailable', code: 'SERVICE_DOWN' });
      if (request.url === '/api/projects/p-1/export?format=json') return send(response, 200, { payload: 'x'.repeat(1_048_576) });
      route(request, response, body);
    });
    httpServer.listen(0, '127.0.0.1');
    await once(httpServer, 'listening');
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Test HTTP server failed to bind.');

    client = new Client({ name: 'mcp-integration-test', version: '1.0.0' }, { capabilities: {} });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve('node_modules/tsx/dist/cli.mjs'), resolve('apps/mcp-server/src/index.ts')],
      cwd: process.cwd(),
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
        PLANNER_SERVICE_URL: `http://127.0.0.1:${address.port}`,
        PLANNER_AGENT_TOKEN: 'agent-test-token',
      },
      stderr: 'inherit',
    });
    await client.connect(transport);

    const listed = await client.listTools();
    const names = listed.tools.map(tool => tool.name).sort();
    expect(names).toEqual([
      'analyze_dependencies', 'analyze_milestone', 'apply_changes', 'calculate_schedule', 'compare_scenarios', 'create_scenario', 'diagnose_plan',
      'explain_risk', 'export_project', 'get_activity', 'get_calendar', 'get_duration_proposal', 'get_import_status', 'get_operation_status', 'get_project',
      'get_tag_catalog', 'get_team', 'list_activities', 'list_calendars', 'list_dependencies', 'list_operation_history', 'list_projects', 'list_scenarios', 'preview_changes', 'request_delete',
      'rename_scenario', 'request_import_project', 'request_manage_baseline', 'request_publish_baseline', 'resolve_duration_proposal', 'set_tag_catalog', 'update_team', 'upsert_calendar',
    ].sort());

    const projects = await client.callTool({ name: 'list_projects', arguments: { limit: 1, offset: 1 } });
    expect(projects.structuredContent).toEqual({
      data: { items: [{ id: 'p-2', name: 'Second', revision: 3 }], offset: 1, limit: 1, total: 2 },
    });
    const activities = await client.callTool({
      name: 'list_activities',
      arguments: { projectId: 'p-1', scenarioId: null, limit: 10, offset: 0 },
    });
    expect(activities.structuredContent).toMatchObject({ data: { items: [{ id: 'a-1' }], total: 1 } });

    const changed = await client.callTool({
      name: 'apply_changes',
      arguments: {
        projectId: 'p-1',
        scenarioId: 's-1',
        expectedRevision: 7,
        operationId: 'op-apply-1',
        changes: { activities: [{ id: 'a-1', patch: { name: 'Updated' } }] },
      },
    });
    expect(changed.structuredContent).toEqual({
      data: {
        result: { status: 'approval_required', operation: { id: 'op-apply-1' } },
        operationId: 'op-apply-1',
      },
    });
    const sent = requests.find(item => item.url === '/api/projects/p-1/commands');
    expect(sent?.authorization).toBe('Bearer agent-test-token');
    expect(sent?.body).toEqual({
      expectedRevision: 7,
      operationId: 'op-apply-1',
      action: 'applyChanges',
      args: [{ activities: [{ id: 'a-1', patch: { name: 'Updated' } }] }],
      scenarioId: 's-1',
    });

    const requestCount = requests.length;
    const invalid = await client.callTool({
      name: 'apply_changes',
      arguments: { projectId: 'p-1', scenarioId: null, expectedRevision: 2, operationId: 'op', changes: {} },
    });
    expect(invalid.isError).toBe(true);
    expect(requests).toHaveLength(requestCount);

    failProjectListing = true;
    const failure = await client.callTool({ name: 'list_projects', arguments: { limit: 10, offset: 0 } });
    expect(failure.isError).toBe(true);
    expect(failure.content).toContainEqual(expect.objectContaining({ text: 'SERVICE_DOWN: Service unavailable' }));

    const oversized = await client.callTool({ name: 'export_project', arguments: { projectId: 'p-1' } });
    expect(oversized.isError).toBe(true);
    expect(oversized.content).toContainEqual(expect.objectContaining({ text: expect.stringContaining('1048576-byte adapter limit') }));
  });

  it('drives the real planner service through SDK stdio, UI approval, and scenario changes', async () => {
    liveDirectory = resolve('test-results', `mcp-live-${randomUUID()}`);
    await mkdir(liveDirectory, { recursive: true });
    const uiToken = `ui-${randomUUID()}`;
    const agentToken = `agent-${randomUUID()}`;
    liveServer = await createPlannerServer({ directory: resolve(liveDirectory, 'projects'), uiToken, agentToken, port: 0 });
    const port = await liveServer.listen();
    const ui = async (path: string, init: RequestInit = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${uiToken}`, 'Content-Type': 'application/json' },
      });
      const value = await response.json();
      expect(response.ok, JSON.stringify(value)).toBe(true);
      return value as any;
    };
    const model = createProject('MCP live integration');
    const projectId = model.project.id;
    await ui('/api/projects', { method: 'POST', body: JSON.stringify({ model, operationId: 'register-live-test' }) });

    client = new Client({ name: 'mcp-live-service-test', version: '1.0.0' }, { capabilities: {} });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve('node_modules/tsx/dist/cli.mjs'), resolve('apps/mcp-server/src/index.ts')],
      cwd: process.cwd(),
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
        PLANNER_SERVICE_URL: `http://127.0.0.1:${port}`,
        PLANNER_AGENT_TOKEN: agentToken,
      },
      stderr: 'inherit',
    });
    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'get_project', 'calculate_schedule', 'create_scenario', 'get_operation_status', 'apply_changes',
    ]));
    const projects = await client.callTool({ name: 'list_projects', arguments: { limit: 10, offset: 0 } });
    expect(projects.structuredContent).toMatchObject({
      data: { items: [{ id: projectId, name: 'MCP live integration', revision: 0 }], total: 1 },
    });
    const project = await client.callTool({ name: 'get_project', arguments: { projectId } });
    expect(project.structuredContent).toMatchObject({ data: { revision: 0, model: { project: { id: projectId } } } });
    const calculated = await client.callTool({ name: 'calculate_schedule', arguments: { projectId, scenarioId: null } });
    expect(calculated.isError, JSON.stringify(calculated.content)).toBeUndefined();
    expect(calculated.structuredContent).toMatchObject({ data: { revision: 0, results: { schedule: { activities: {} } } } });

    const requested = await client.callTool({
      name: 'create_scenario',
      arguments: { projectId, scenarioId: null, name: 'Agent what-if', clone: false, expectedRevision: 0, operationId: 'create-scenario-live-test' },
    });
    expect(requested.isError, JSON.stringify(requested.content)).toBeUndefined();
    expect(requested.structuredContent).toMatchObject({
      data: { result: { status: 'approval_required', operation: { id: expect.any(String) } } },
    });
    const approvalId = (requested.structuredContent as any).data.result.operation.id as string;
    const pending = await client.callTool({ name: 'get_operation_status', arguments: { projectId, operationId: approvalId } });
    expect(pending.structuredContent).toMatchObject({ data: { id: approvalId, status: 'pending', action: 'newScenario' } });

    await ui(`/api/projects/${projectId}/operations/${approvalId}/decision`, { method: 'POST', body: JSON.stringify({ approve: true }) });
    const approved = await client.callTool({ name: 'get_operation_status', arguments: { projectId, operationId: approvalId } });
    expect(approved.structuredContent).toMatchObject({ data: { id: approvalId, status: 'approved' } });

    const scenarios = await client.callTool({ name: 'list_scenarios', arguments: { projectId } });
    const scenarioData = (scenarios.structuredContent as any).data;
    const scenario = scenarioData.items.find((item: { name: string }) => item.name === 'Agent what-if');
    expect(scenario).toBeDefined();
    expect(scenarioData.revision).toBe(1);
    const calendars = await client.callTool({ name: 'list_calendars', arguments: { projectId, scenarioId: scenario.id, limit: 10, offset: 0 } });
    expect(calendars.structuredContent).toMatchObject({ data: { total: 1, items: [{ id: 'standard' }], revision: 1 } });
    const diagnostics = await client.callTool({ name: 'diagnose_plan', arguments: { projectId, scenarioId: scenario.id, limit: 10, offset: 0 } });
    expect(diagnostics.isError, JSON.stringify(diagnostics.content)).toBeUndefined();
    expect(diagnostics.structuredContent).toMatchObject({ data: { revision: 1, total: 0 } });

    const applied = await client.callTool({
      name: 'apply_changes',
      arguments: {
        projectId, scenarioId: scenario.id, expectedRevision: 1, operationId: 'apply-live-test',
        changes: { activities: [{ patch: { code: 'MCP-001', name: 'Agent activity', duration: 2 } }] },
      },
    });
    expect(applied.isError, JSON.stringify(applied.content)).toBeUndefined();
    expect(applied.structuredContent).toMatchObject({ data: { result: { revision: 2 }, operationId: 'apply-live-test' } });

    const scenarioActivities = await client.callTool({
      name: 'list_activities',
      arguments: { projectId, scenarioId: scenario.id, limit: 10, offset: 0 },
    });
    expect(scenarioActivities.structuredContent).toMatchObject({
      data: { items: [{ code: 'MCP-001', name: 'Agent activity', duration: 2 }], total: 1, revision: 2 },
    });
    const filtered = await client.callTool({
      name: 'list_activities',
      arguments: { projectId, scenarioId: scenario.id, limit: 10, offset: 0, text: 'AGENT' },
    });
    expect(filtered.structuredContent).toMatchObject({ data: { total: 1, revision: 2 } });
    const renamed = await client.callTool({
      name: 'rename_scenario',
      arguments: { projectId, scenarioId: scenario.id, name: 'Renamed', expectedRevision: 2, operationId: 'rename-live-test' },
    });
    expect(renamed.isError, JSON.stringify(renamed.content)).toBeUndefined();
    expect(renamed.structuredContent).toMatchObject({ data: { result: { revision: 3 } } });
    const activityId = (scenarioActivities.structuredContent as any).data.items[0].id as string;
    const proposalWrite = await client.callTool({ name: 'apply_changes', arguments: {
      projectId, scenarioId: scenario.id, expectedRevision: 3, operationId: 'proposal-live-test',
      changes: { activities: [{ id: activityId, patch: { effortHours: 16 } }] },
    } });
    expect(proposalWrite.isError, JSON.stringify(proposalWrite.content)).toBeUndefined();
    const pendingProposal = await client.callTool({ name: 'get_duration_proposal', arguments: { projectId, scenarioId: scenario.id } });
    expect(pendingProposal.structuredContent).toMatchObject({ data: { revision: 4, proposal: { id: expect.any(String) } } });
    const proposalId = (pendingProposal.structuredContent as any).data.proposal.id as string;
    const resolution = await client.callTool({ name: 'resolve_duration_proposal', arguments: {
      projectId, scenarioId: scenario.id, expectedRevision: 4, operationId: 'resolve-live-test',
      proposalId, resolution: 'apply_selected', activityIds: [activityId],
    } });
    expect(resolution.isError, JSON.stringify(resolution.content)).toBeUndefined();
    expect(resolution.structuredContent).toMatchObject({ data: { result: { revision: 5 } } });
    const history = await client.callTool({ name: 'list_operation_history', arguments: { projectId, limit: 10, offset: 0, actor: 'agent' } });
    expect(history.structuredContent).toMatchObject({ data: { retentionLimit: 1000, items: expect.arrayContaining([expect.objectContaining({ action: 'finishEdit' })]) } });
    const tagUpdate = await client.callTool({ name: 'set_tag_catalog', arguments: {
      projectId, scenarioId: scenario.id, expectedRevision: 5, operationId: 'tags-live', tags: ['Important'],
    } });
    expect(tagUpdate.isError, JSON.stringify(tagUpdate.content)).toBeUndefined();
    const tags = await client.callTool({ name: 'get_tag_catalog', arguments: { projectId, scenarioId: scenario.id } });
    expect(tags.structuredContent).toMatchObject({ data: { revision: 6, tags: ['Important'] } });
    const teamUpdate = await client.callTool({ name: 'update_team', arguments: {
      projectId, scenarioId: scenario.id, expectedRevision: 6, operationId: 'team-live',
      team: { name: 'Team', calendarId: 'standard', members: [{ id: 'alice', name: 'Alice', allocationPercent: 100 }] },
    } });
    expect(teamUpdate.isError, JSON.stringify(teamUpdate.content)).toBeUndefined();
    const team = await client.callTool({ name: 'get_team', arguments: { projectId, scenarioId: scenario.id } });
    expect(team.structuredContent).toMatchObject({ data: { revision: 7, team: { members: [{ id: 'alice' }] } } });
    const calendarUpdate = await client.callTool({ name: 'upsert_calendar', arguments: {
      projectId, scenarioId: scenario.id, expectedRevision: 7, operationId: 'calendar-live',
      calendar: { ...importedCalendar(), id: 'alternate' },
    } });
    expect(calendarUpdate.isError, JSON.stringify(calendarUpdate.content)).toBeUndefined();
    const calendar = await client.callTool({ name: 'get_calendar', arguments: { projectId, scenarioId: scenario.id, calendarId: 'alternate' } });
    expect(calendar.structuredContent).toMatchObject({ data: { revision: 8, calendar: { id: 'alternate' } } });
    const dependencies = await client.callTool({ name: 'analyze_dependencies', arguments: { projectId, scenarioId: scenario.id, limit: 10, offset: 0 } });
    expect(dependencies.isError, JSON.stringify(dependencies.content)).toBeUndefined();
    expect(dependencies.structuredContent).toMatchObject({ data: { revision: 8, total: 0 } });
    const importedModel = createProject('Imported via MCP');
    const imported = await client.callTool({ name: 'request_import_project', arguments: { operationId: 'import-live', model: importedModel } });
    expect(imported.isError, JSON.stringify(imported.content)).toBeUndefined();
    expect(imported.structuredContent).toMatchObject({ data: { projectId: importedModel.project.id, status: 'pending' } });
    const importId = (imported.structuredContent as any).data.id as string;
    await ui(`/api/imports/${importId}/decision`, { method: 'POST', body: JSON.stringify({ approve: true }) });
    const importStatus = await client.callTool({ name: 'get_import_status', arguments: { importId } });
    expect(importStatus.structuredContent).toMatchObject({ data: { status: 'approved' } });
    const backend = await ui(`/api/projects/${projectId}`);
    expect(backend.revision).toBe(8);
    expect(backend.model.activities).toEqual([]);
    expect(backend.model.overrides).toContainEqual(expect.objectContaining({
      scenarioId: scenario.id,
      entityType: 'activity',
      fieldName: '$entity',
      value: expect.objectContaining({ code: 'MCP-001', name: 'Agent activity', duration: 2 }),
    }));
  });
});

function importedCalendar() {
  return { name: 'Alternate', workingDays: [1, 2, 3, 4, 5], workingIntervals: [{ start: '09:00', end: '17:00' }],
    holidays: [], exceptions: [] };
}

function route(request: IncomingMessage, response: ServerResponse, body: any): void {
  if (request.url === '/api/projects') return send(response, 200, [
    { id: 'p-1', name: 'Test Project', revision: 7 },
    { id: 'p-2', name: 'Second', revision: 3 },
  ]);
  if (request.url === '/api/projects/p-1') return send(response, 200, {
    model, revision: 7, activeScenarioId: 's-1', dirty: true, canUndo: true, canRedo: false,
  });
  if (request.url === '/api/projects/p-1/activities/query') return send(response, 200, {
    items: model.activities, total: 1, revision: 7, scenarioId: body.scenarioId, limit: body.limit, offset: body.offset,
  });
  if (request.url === '/api/projects/p-1/commands') return send(response, 200, {
    status: 'approval_required', operation: { id: body.operationId },
  });
  return send(response, 404, { error: 'Not found', code: 'NOT_FOUND' });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}
