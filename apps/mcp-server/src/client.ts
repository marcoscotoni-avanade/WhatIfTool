import type { PlannerConnection } from './config';

export interface ProjectSummary {
  id: string;
  name: string;
  revision: number;
}

export interface ProjectResponse {
  model: Record<string, unknown>;
  revision: number;
  activeScenarioId?: string;
  pendingEdit?: unknown;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

export interface CommandRequest {
  expectedRevision: number;
  operationId: string;
  action: string;
  args: unknown;
  scenarioId?: string;
  selection?: Record<string, unknown>;
}

export class PlannerHttpError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'PlannerHttpError';
    this.status = status;
    this.code = code;
  }
}

export class PlannerClient {
  private readonly connection: PlannerConnection;

  constructor(connection: PlannerConnection) {
    this.connection = connection;
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const value = await this.request<unknown>('/api/projects');
    if (!Array.isArray(value)) throw new Error('Planner service returned an invalid project list.');
    return value.map((item, index) => {
      if (!item || typeof item !== 'object') throw new Error(`Planner service returned an invalid project at index ${index}.`);
      const project = item as Record<string, unknown>;
      if (typeof project.id !== 'string' || typeof project.name !== 'string' || typeof project.revision !== 'number') {
        throw new Error(`Planner service returned an invalid project at index ${index}.`);
      }
      return { id: project.id, name: project.name, revision: project.revision };
    });
  }

  getProject(projectId: string): Promise<ProjectResponse> {
    return this.request<unknown>(`/api/projects/${encodeURIComponent(projectId)}`).then(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Planner service returned an invalid project response.');
      const project = value as Record<string, unknown>;
      if (!project.model || typeof project.model !== 'object' || Array.isArray(project.model)
        || typeof project.revision !== 'number' || typeof project.dirty !== 'boolean'
        || typeof project.canUndo !== 'boolean' || typeof project.canRedo !== 'boolean'
        || (project.activeScenarioId !== undefined && typeof project.activeScenarioId !== 'string')) {
        throw new Error('Planner service returned an invalid project response.');
      }
      return project as unknown as ProjectResponse;
    });
  }

  queryActivities(projectId: string, input: unknown): Promise<unknown> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/activities/query`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  getDurationProposal(projectId: string, scenarioId: string | null): Promise<unknown> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/duration-proposal`, {
      method: 'POST',
      body: JSON.stringify({ scenarioId }),
    });
  }

  getMetadata(projectId: string, input: unknown): Promise<unknown> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/metadata`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  queryAnalysis(projectId: string, route: 'dependencies/query' | 'diagnose', input: unknown): Promise<unknown> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/${route}`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  queryHistory(projectId: string, input: unknown): Promise<unknown> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/history/query`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  requestImport(model: unknown, operationId: string): Promise<unknown> {
    return this.request('/api/imports', { method: 'POST', body: JSON.stringify({ model, operationId }) });
  }

  getImport(id: string): Promise<unknown> {
    return this.request(`/api/imports/${encodeURIComponent(id)}`);
  }

  command(projectId: string, command: CommandRequest): Promise<unknown> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/commands`, {
      method: 'POST',
      body: JSON.stringify(command),
    });
  }

  preview(projectId: string, command: CommandRequest): Promise<unknown> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/preview`, {
      method: 'POST',
      body: JSON.stringify(command),
    });
  }

  calculate(projectId: string, input: { scenarioId?: string; milestoneId?: string }): Promise<unknown> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/calculate`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  compare(projectId: string, input: { scenarioId: string; milestoneId?: string }): Promise<unknown> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/compare`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  getOperation(projectId: string, operationId: string): Promise<unknown> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/operations/${encodeURIComponent(operationId)}`);
  }

  exportProject(projectId: string): Promise<unknown> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/export?format=json`, {}, 1_048_576);
  }

  private async request<T>(path: string, init: RequestInit = {}, maxResponseBytes = 8 * 1024 * 1024): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.connection.url}${path}`, {
        ...init,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.connection.agentToken}`,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new Error(`Unable to reach the planner service: ${error instanceof Error ? error.message : String(error)}`);
    }

    const text = await readResponse(response, maxResponseBytes);
    let value: unknown;
    try {
      value = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`Planner service returned invalid JSON (HTTP ${response.status}).`);
    }

    async function readResponse(response: Response, maxBytes: number): Promise<string> {
      if (!response.body) return '';
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > maxBytes) {
            await reader.cancel();
            throw new Error(`Planner service response exceeds the ${maxBytes}-byte adapter limit.`);
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder().decode(bytes);
    }
    if (!response.ok) {
      const body = value && typeof value === 'object' ? value as Record<string, unknown> : {};
      const message = typeof body.error === 'string' ? body.error : `Planner service request failed (HTTP ${response.status}).`;
      const code = typeof body.code === 'string' ? body.code : undefined;
      throw new PlannerHttpError(message, response.status, code);
    }
    return value as T;
  }
}
