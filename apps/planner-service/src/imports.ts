import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseProject, type ProjectModel } from '@planner/domain';
import { validateDocument } from '@planner/scenarios';
import { atomicJson } from './repository';
import { ServiceError } from './contracts';
import type { PlannerService } from './planner';

type ImportStatus = 'pending' | 'approving' | 'approved' | 'rejected' | 'expired' | 'conflict';
interface ImportRecord {
  id: string; operationId: string; hash: string; status: ImportStatus; expiresAt: string;
  reason?: 'PROJECT_EXISTS' | 'PAYLOAD_CHANGED';
  model: ProjectModel;
}

export class ImportQueue {
  private readonly path: string;
  private readonly service: PlannerService;
  private entries: ImportRecord[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  constructor(directory: string, service: PlannerService) {
    this.path = join(directory, '_imports', 'queue.json');
    this.service = service;
  }
  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => undefined).then(run);
    this.queue = next;
    return next;
  }
  private async persist() { await atomicJson(this.path, this.entries); }
  private summary(entry: ImportRecord) {
    const status = entry.status === 'pending' && Date.parse(entry.expiresAt) < Date.now() ? 'expired' : entry.status;
    return { id: entry.id, operationId: entry.operationId, status, expiresAt: entry.expiresAt, hash: entry.hash,
      ...(entry.reason ? { reason: entry.reason } : {}),
      projectId: entry.model.project.id, name: entry.model.project.name,
      counts: { activities: entry.model.activities.length, dependencies: entry.model.dependencies.length,
        scenarios: entry.model.scenarios.length, baselines: entry.model.baselines.length, calendars: entry.model.calendars.length } };
  }
  async initialize() {
    await mkdir(join(this.service.repository.directory, '_imports'), { recursive: true, mode: 0o700 });
    try { this.entries = JSON.parse(await readFile(this.path, 'utf8')) as ImportRecord[]; }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    for (const entry of this.entries.filter(item => item.status === 'approving')) await this.complete(entry);
  }
  private async complete(entry: ImportRecord) {
    const digest = createHash('sha256').update(JSON.stringify(entry.model)).digest('hex');
    if (digest !== entry.hash) {
      entry.status = 'conflict';
      entry.reason = 'PAYLOAD_CHANGED';
    } else try {
      await this.service.registerImport(entry.model, entry.id);
      entry.status = 'approved';
    } catch (error) {
      if (!(error instanceof ServiceError && error.code === 'PROJECT_EXISTS')) throw error;
      entry.status = 'conflict';
      entry.reason = 'PROJECT_EXISTS';
    }
    try { await this.persist(); }
    catch (error) { entry.status = 'approving'; delete entry.reason; throw error; }
  }
  request(raw: unknown, operationId: string) {
    return this.exclusive(async () => {
      if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > 2 * 1024 * 1024) throw new ServiceError(413, 'IMPORT_TOO_LARGE', 'Import exceeds 2 MiB.');
      let model: ProjectModel;
      try {
        const parsed = parseProject(raw);
        model = { schemaVersion: parsed.schemaVersion, project: parsed.project, activities: parsed.activities,
          dependencies: parsed.dependencies, calendars: parsed.calendars, settings: parsed.settings,
          scenarios: parsed.scenarios, overrides: parsed.overrides, baselines: parsed.baselines };
        validateDocument(model);
      }
      catch (error) { throw new ServiceError(422, 'VALIDATION', error instanceof Error ? error.message : 'Invalid project document.'); }
      if (!/^[\w-]{1,128}$/.test(model.project.id)) throw new ServiceError(422, 'VALIDATION', 'Invalid project ID.');
      if (model.activities.length > 10_000 || model.dependencies.length > 20_000 || model.scenarios.length > 1000)
        throw new ServiceError(413, 'IMPORT_TOO_LARGE', 'Import exceeds entity limits.');
      const digest = createHash('sha256').update(JSON.stringify(model)).digest('hex');
      const existing = this.entries.find(entry => entry.operationId === operationId);
      if (existing) {
        if (existing.hash !== digest) throw new ServiceError(409, 'OPERATION_ID_REUSED', 'Operation ID already used with a different payload.');
        return { ...this.summary(existing), replayed: true };
      }
      if (await this.service.repository.read(model.project.id)) throw new ServiceError(409, 'PROJECT_EXISTS', 'A project with this ID already exists.');
      if (this.entries.filter(entry => entry.status === 'pending' && Date.parse(entry.expiresAt) >= Date.now()).length >= 100)
        throw new ServiceError(429, 'IMPORT_QUEUE_FULL', 'Too many pending imports.');
      const entry: ImportRecord = { id: randomUUID(), operationId, hash: digest, status: 'pending',
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), model };
      const previous = this.entries;
      const active = previous.filter(item => item.status === 'approving' || (item.status === 'pending' && Date.parse(item.expiresAt) >= Date.now()));
      const retained = previous.filter(item => !active.includes(item)).slice(-400);
      this.entries = [...retained, ...active, entry];
      try { await this.persist(); } catch (error) { this.entries = previous; throw error; }
      return this.summary(entry);
    });
  }
  list() { return this.entries.map(entry => this.summary(entry)); }
  get(id: string) {
    const entry = this.entries.find(item => item.id === id);
    if (!entry) throw new ServiceError(404, 'NOT_FOUND', 'Import request not found.');
    return this.summary(entry);
  }
  decide(id: string, approve: boolean) {
    return this.exclusive(async () => {
      const entry = this.entries.find(item => item.id === id);
      if (!entry) throw new ServiceError(404, 'NOT_FOUND', 'Import request not found.');
      if (entry.status === 'approving' && approve) { await this.complete(entry); return this.summary(entry); }
      if (entry.status !== 'pending') throw new ServiceError(409, 'APPROVAL_USED', 'Import request already processed.');
      if (Date.parse(entry.expiresAt) < Date.now()) entry.status = 'expired';
      else if (!approve) entry.status = 'rejected';
      else {
        entry.status = 'approving';
        try { await this.persist(); } catch (error) { entry.status = 'pending'; throw error; }
        await this.complete(entry);
        return this.summary(entry);
      }
      try { await this.persist(); } catch (error) { entry.status = 'pending'; throw error; }
      return this.summary(entry);
    });
  }
}
