import { parseProject, type Activity, type Dependency, type ProjectModel } from '@planner/domain';
import { validateDocument } from '@planner/scenarios';

export function exportJson(m: ProjectModel): string { return JSON.stringify(m, null, 2); }
export function importJson(text: string): ProjectModel {
  const m = parseProject(JSON.parse(text));
  validateDocument(m);
  return m;
}
export function parseCsv(text: string, delimiter: ',' | '\t' = ','): Record<string, string>[] {
  const format = delimiter === '\t' ? 'TSV' : 'CSV';
  const rows: string[][] = [], row: string[] = [];
  let cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted;
    } else if (ch === delimiter && !quoted) { row.push(cell); cell = ''; }
    else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); if (row.some(Boolean)) rows.push([...row]); row.length = 0; cell = '';
    } else cell += ch;
  }
  if (quoted) throw new Error(`Unclosed quote in ${format}.`);
  row.push(cell); if (row.some(Boolean)) rows.push(row);
  const headers = rows.shift();
  if (!headers?.length || new Set(headers).size !== headers.length) throw new Error(`Invalid ${format} headers.`);
  return rows.map((r, i) => {
    if (r.length !== headers.length) throw new Error(`${format} row ${i + 2} has an incorrect number of columns.`);
    return Object.fromEntries(headers.map((h, j) => [h.replace(/^\uFEFF/, ''), r[j]!]));
  });
}
export function toCsv(rows: object[], headers?: string[]): string {
  const keys = headers ?? [...new Set(rows.flatMap(r => Object.keys(r)))];
  const quote = (v: unknown) => `"${String(typeof v === 'object' && v !== null ? JSON.stringify(v) : v ?? '').replaceAll('"', '""')}"`;
  return [keys.map(quote).join(','), ...rows.map(row => keys.map(k => quote(Reflect.get(row, k))).join(','))].join('\r\n');
}
export function importCsv(m: ProjectModel, text: string, kind: 'activities' | 'dependencies'): ProjectModel {
  const next = structuredClone(m);
  const rows = parseCsv(text);
  const parseTags = (value?: string): string[] | undefined => {
    if (!value) return undefined;
    const tags: unknown = value.trim().startsWith('[') ? JSON.parse(value) : value.split(',').map(tag => tag.trim()).filter(Boolean);
    if (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string')) throw new Error('CSV task tags must be a comma-separated list or a JSON string array.');
    return tags;
  };
  if (kind === 'activities' && rows.some(r => r.elapsedMode && !['true', 'false'].includes(r.elapsedMode)))
    throw new Error('CSV elapsedMode must be true or false.');
  if (kind === 'activities') {
    next.activities = rows.map((r, i): Activity => ({
      id: r.id || crypto.randomUUID(), projectId: next.project.id, code: r.code || `ACT-${i + 1}`,
      name: r.name || '', description: r.description,
      tags: parseTags(r.tags),
      type: (r.type || 'TASK') as Activity['type'],
      effortHours: Number(r.effortHours || 0), duration: Number(r.duration || 0),
      durationUnit: (r.durationUnit || 'd') as Activity['durationUnit'], elapsedMode: r.elapsedMode === 'true',
      scheduleMode: (r.scheduleMode || 'AUTO') as Activity['scheduleMode'], plannedStart: r.plannedStart || undefined,
      plannedFinish: r.plannedFinish || undefined, intrinsicRisk: r.intrinsicRisk ? Number(r.intrinsicRisk) : undefined,
      probabilityOfDelay: r.probabilityOfDelay ? Number(r.probabilityOfDelay) : undefined, delayP80: r.delayP80 ? Number(r.delayP80) : undefined,
      constraintType: (r.constraintType || undefined) as Activity['constraintType'], constraintDate: r.constraintDate || undefined,
      actualStart: r.actualStart || undefined, actualFinish: r.actualFinish || undefined, calendarId: r.calendarId || undefined, ownerId: r.ownerId || undefined,
      status: (r.status || 'NOT_STARTED') as Activity['status'], targetDate: r.targetDate || undefined,
      graphPosition: r.graphPosition ? JSON.parse(r.graphPosition) as Activity['graphPosition'] : { x: (i % 5) * 330, y: Math.floor(i / 5) * 240 },
    }));
    const assignedTags = next.activities.flatMap(activity => activity.type === 'TASK' ? activity.tags ?? [] : []);
    if (next.project.tagCatalog !== undefined || assignedTags.length) {
      const catalog = next.project.tagCatalog ?? [], known = new Set(catalog.map(tag => tag.toLocaleLowerCase()));
      next.project.tagCatalog = [...catalog, ...assignedTags.filter(tag => {
        const key = tag.toLocaleLowerCase();
        if (known.has(key)) return false;
        known.add(key);
        return true;
      })];
      const canonicalTags = new Map(next.project.tagCatalog.map(tag => [tag.toLocaleLowerCase(), tag]));
      for (const activity of next.activities) {
        if (activity.type === 'TASK' && activity.tags) activity.tags = activity.tags.map(tag => canonicalTags.get(tag.toLocaleLowerCase()) ?? tag);
      }
    }
  } else {
    next.dependencies = rows.map((r): Dependency => ({
      id: r.id || crypto.randomUUID(), projectId: next.project.id, predecessorId: r.predecessorId || '',
      successorId: r.successorId || '', type: (r.type || 'FS') as Dependency['type'], lag: Number(r.lag || 0),
      lagUnit: (r.lagUnit || 'd') as Dependency['lagUnit'], edgeWeight: r.edgeWeight ? Number(r.edgeWeight) : undefined,
    }));
  }
  validateDocument(next);
  return next;
}
