import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { parseProject, type CalculationResults, type ProjectModel, type Scenario } from '@planner/domain';
import { validateDocument } from '@planner/scenarios';

export interface ProjectSummary { id: string; name: string; modifiedAt: string }
export interface BinaryStore {
  read(id: string): Promise<Uint8Array | undefined>;
  write(id: string, bytes: Uint8Array): Promise<void>;
  remove(id: string): Promise<void>;
  keys(): Promise<string[]>;
}
export interface ProjectRepository {
  listProjects(): Promise<ProjectSummary[]>;
  loadProject(id: string): Promise<ProjectModel>;
  saveProject(model: ProjectModel, results?: CalculationResults): Promise<void>;
  deleteProject(id: string): Promise<void>;
  saveScenario(projectId: string, scenario: Scenario): Promise<void>;
  loadScenario(projectId: string, scenarioId: string): Promise<Scenario>;
}
const tables = ['Activities', 'Dependencies', 'Calendars', 'CalendarExceptions', 'Scenarios', 'ScenarioOverrides', 'Baselines', 'SimulationResults', 'ApplicationSettings'];
export const MIGRATION_1 = `
CREATE TABLE Projects (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
${tables.map(t => `CREATE TABLE ${t} (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES Projects(id) ON DELETE CASCADE, payload TEXT NOT NULL);`).join('\n')}
${tables.map(t => `CREATE INDEX idx_${t}_project ON ${t}(project_id);`).join('\n')}
PRAGMA user_version=1;`;

export class SqliteProjectRepository implements ProjectRepository {
  private readonly sql: SqlJsStatic;
  private readonly store: BinaryStore;
  constructor(sql: SqlJsStatic, store: BinaryStore) { this.sql = sql; this.store = store; }
  static async create(store: BinaryStore, locateFile: (name: string) => string): Promise<SqliteProjectRepository> {
    return new SqliteProjectRepository(await initSqlJs({ locateFile }), store);
  }
  private open(bytes?: Uint8Array): Database {
    const db = bytes ? new this.sql.Database(bytes) : new this.sql.Database();
    try {
      db.run('PRAGMA foreign_keys=ON');
      const version = Number(db.exec('PRAGMA user_version')[0]?.values[0]?.[0] ?? 0);
      if (version === 0 && !bytes) db.run(MIGRATION_1);
      else if (version !== 1) throw new Error('Unsupported or invalid project database version.');
      return db;
    } catch (error) { db.close(); throw error; }
  }
  encode(model: ProjectModel, results?: CalculationResults): Uint8Array {
    validateDocument(model);
    const db = this.open();
    try {
      db.run('BEGIN IMMEDIATE');
      db.run('INSERT INTO Projects VALUES (?,?)', [model.project.id, JSON.stringify({ schemaVersion: model.schemaVersion, ...model.project })]);
      const insert = (table: string, rows: { id: string }[]) => {
        const statement = db.prepare(`INSERT INTO ${table} VALUES (?,?,?)`);
        try { for (const row of rows) statement.run([row.id, model.project.id, JSON.stringify(row)]); }
        finally { statement.free(); }
      };
      insert('Activities', model.activities); insert('Dependencies', model.dependencies);
      insert('Calendars', model.calendars.map(c => ({ ...c, exceptions: [] })));
      insert('CalendarExceptions', model.calendars.flatMap(c => c.exceptions.map(e => ({ ...e, id: `${c.id}:${e.date}`, calendarId: c.id }))));
      insert('Scenarios', model.scenarios); insert('ScenarioOverrides', model.overrides); insert('Baselines', model.baselines);
      insert('ApplicationSettings', [{ id: 'risk', ...model.settings }]);
      if (results) insert('SimulationResults', [{ id: 'latest', ...results }]);
      db.run('COMMIT');
      return db.export();
    } catch (error) {
      db.run('ROLLBACK');
      throw error;
    } finally { db.close(); }
  }
  decode(bytes: Uint8Array): ProjectModel {
    const db = this.open(bytes);
    try {
      const rows = <T>(table: string): T[] => {
        const result = db.exec(`SELECT payload FROM ${table} ORDER BY rowid`)[0];
        return (result?.values ?? []).map(r => JSON.parse(String(r[0])) as T);
      };
      const project = rows<ProjectModel['project'] & { schemaVersion: number }>('Projects')[0];
      if (!project) throw new Error('Project database is empty.');
      const { schemaVersion, ...metadata } = project;
      const calendars = rows<ProjectModel['calendars'][number]>('Calendars');
      const exceptions = rows<ProjectModel['calendars'][number]['exceptions'][number] & { calendarId: string }>('CalendarExceptions');
      for (const c of calendars) c.exceptions = exceptions.filter(e => e.calendarId === c.id).map(e => ({ date: e.date, intervals: e.intervals }));
      const m = parseProject({ schemaVersion, project: metadata, activities: rows('Activities'), dependencies: rows('Dependencies'),
        calendars, scenarios: rows('Scenarios'), overrides: rows('ScenarioOverrides'), baselines: rows('Baselines'),
        settings: (() => { const { id: _id, ...settings } = rows<{ id: string } & ProjectModel['settings']>('ApplicationSettings')[0]!; return settings; })() });
      validateDocument(m);
      return m;
    } finally { db.close(); }
  }
  async saveProject(model: ProjectModel, results?: CalculationResults): Promise<void> {
    await this.store.write(model.project.id, this.encode(model, results));
  }
  async loadProject(id: string): Promise<ProjectModel> {
    const bytes = await this.store.read(id);
    if (!bytes) throw new Error('Saved project not found.');
    return this.decode(bytes);
  }
  async listProjects(): Promise<ProjectSummary[]> {
    const projects: ProjectSummary[] = [];
    for (const id of await this.store.keys()) {
      const m = await this.loadProject(id);
      projects.push({ id, name: m.project.name, modifiedAt: m.project.modifiedAt });
    }
    return projects.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }
  async deleteProject(id: string): Promise<void> { await this.store.remove(id); }
  async saveScenario(projectId: string, scenario: Scenario): Promise<void> {
    const m = await this.loadProject(projectId);
    const index = m.scenarios.findIndex(s => s.id === scenario.id);
    if (index >= 0 && m.scenarios[index]!.isBaseline) throw new Error('Published baseline is immutable.');
    if (index >= 0) m.scenarios[index] = scenario; else m.scenarios.push(scenario);
    await this.saveProject(m);
  }
  async loadScenario(projectId: string, scenarioId: string): Promise<Scenario> {
    const scenario = (await this.loadProject(projectId)).scenarios.find(s => s.id === scenarioId);
    if (!scenario) throw new Error('Scenario not found.');
    return scenario;
  }
}
export * from './exchange';
