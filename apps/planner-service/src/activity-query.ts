import { z } from 'zod';
import type { Activity, CalculationResults, ProjectSnapshot } from '@planner/domain';

const date = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);
export const activityQuerySchema = z.object({
  scenarioId: z.string().min(1).nullable(),
  limit: z.number().int().min(1).max(100),
  offset: z.number().int().nonnegative(),
  text: z.string().trim().min(1).optional(),
  ownerId: z.string().min(1).nullable().optional(),
  type: z.enum(['TASK', 'MILESTONE', 'SUMMARY']).optional(),
  status: z.enum(['NOT_STARTED', 'IN_PROGRESS', 'COMPLETE']).optional(),
  tags: z.object({ values: z.array(z.string().min(1)).min(1).max(100), match: z.enum(['any', 'all']) }).strict().optional(),
  date: z.object({
    field: z.enum(['plannedStart', 'plannedFinish', 'calculatedStart', 'calculatedFinish']),
    from: date.optional(),
    to: date.optional(),
  }).strict().refine(value => value.from !== undefined || value.to !== undefined, 'A date bound is required.')
    .refine(value => !value.from || !value.to || Date.parse(value.from) <= Date.parse(value.to), 'Date bounds are reversed.').optional(),
  sort: z.object({ field: z.enum(['id', 'code', 'name', 'type', 'status', 'plannedStart', 'plannedFinish']),
    direction: z.enum(['asc', 'desc']) }).strict().optional(),
}).strict();
export type ActivityQuery = z.infer<typeof activityQuerySchema>;

export function queryActivities(snapshot: ProjectSnapshot, query: ActivityQuery, calculation?: CalculationResults) {
  const search = query.text?.toLocaleLowerCase();
  const items = snapshot.activities.filter(activity => {
    if (search && ![activity.code, activity.name, activity.description ?? ''].some(value => value.toLocaleLowerCase().includes(search))) return false;
    if (query.ownerId !== undefined && (activity.ownerId ?? null) !== query.ownerId) return false;
    if (query.type && activity.type !== query.type) return false;
    if (query.status && activity.status !== query.status) return false;
    if (query.tags) {
      const matches = query.tags.values.map(tag => activity.tags?.includes(tag) ?? false);
      if (query.tags.match === 'all' ? matches.some(match => !match) : !matches.some(Boolean)) return false;
    }
    if (query.date) {
      const field = query.date.field;
      const value = field === 'calculatedStart' || field === 'calculatedFinish'
        ? calculation?.schedule.activities[activity.id]?.[field] : activity[field];
      if (!value) return false;
      const time = Date.parse(value);
      const upper = query.date.to && /^\d{4}-\d{2}-\d{2}$/.test(query.date.to)
        ? Date.parse(query.date.to) + 86_400_000 - 1 : query.date.to ? Date.parse(query.date.to) : undefined;
      if ((query.date.from && time < Date.parse(query.date.from)) || (upper !== undefined && time > upper)) return false;
    }
    return true;
  });
  const field = query.sort?.field ?? 'id';
  const direction = query.sort?.direction === 'desc' ? -1 : 1;
  items.sort((a: Activity, b: Activity) => {
    const first = a[field] ?? '', second = b[field] ?? '';
    return direction * (first < second ? -1 : first > second ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  return { items: items.slice(query.offset, query.offset + query.limit), total: items.length,
    offset: query.offset, limit: query.limit, scenarioId: query.scenarioId };
}
