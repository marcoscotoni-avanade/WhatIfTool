import { mkdir, readFile, readdir, rename, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProjectModel } from '@planner/domain';
import type { PendingEdit } from '../../../packages/application/src/index';

export interface SavedCommand {
  name: string; before: ProjectModel; after: ProjectModel; beforeScenarioId?: string; afterScenarioId?: string;
}
export interface Approval {
  id: string; status: 'pending' | 'approved' | 'rejected' | 'expired' | 'conflict';
  action: string; args: unknown[]; scenarioId?: string; expectedRevision: number;
  expiresAt: string; payloadHash: string;
  diff: { target: string; id: string; before?: unknown; after?: unknown }[];
  command: import('./contracts').PlannerCommand;
}
export interface ProjectRecord {
  model: ProjectModel; revision: number; dirty: boolean; activeScenarioId?: string; pendingEdit?: PendingEdit;
  importId?: string;
  history: SavedCommand[]; future: SavedCommand[];
  approvals: Approval[];
  operations: { id: string; hash: string; actor: string; revision: number; approvalId?: string }[];
  audit: { at: string; actor: string; action: string; revision: number; operationId: string; outcome: string }[];
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx', flush: true });
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, path); break; }
      catch (error) {
        const code = error instanceof Error && 'code' in error ? error.code : undefined;
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(String(code)) || attempt >= 7) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.min(30 * 2 ** attempt, 250)));
      }
    }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
export class FileProjectRepository {
  readonly directory: string;
  constructor(directory: string) { this.directory = directory; }
  private path(id: string) {
    if (!/^[\w-]{1,128}$/.test(id)) throw new Error('Invalid project ID.');
    return join(this.directory, `${id}.json`);
  }
  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const file of await readdir(this.directory)) {
      if (!file.endsWith('.json')) continue;
      const record = await this.read(file.slice(0, -5));
      if (record?.pendingEdit && !record.pendingEdit.id) {
        record.pendingEdit.id = randomUUID();
        await this.write(record);
      }
    }
  }
  async read(id: string): Promise<ProjectRecord | undefined> {
    try { return JSON.parse(await readFile(this.path(id), 'utf8')) as ProjectRecord; }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    }
  }
  async write(record: ProjectRecord) { await atomicJson(this.path(record.model.project.id), record); }
  async list() {
    const records: { id: string; name: string; revision: number }[] = [];
    for (const file of await readdir(this.directory)) {
      if (!file.endsWith('.json')) continue;
      const record = await this.read(file.slice(0, -5));
      if (record) records.push({ id: record.model.project.id, name: record.model.project.name, revision: record.revision });
    }
    return records;
  }
}
