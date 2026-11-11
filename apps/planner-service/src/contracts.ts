import { z } from 'zod';

const patch = z.record(z.string(), z.unknown()).refine(value =>
  !Object.keys(value).some(key => ['__proto__', 'constructor', 'prototype', 'id', 'projectId'].includes(key)), 'Immutable or unsafe patch field.');
export const batchSchema = z.object({
  activities: z.array(z.object({ id: z.string().optional(), patch })).max(1000).optional(),
  dependencies: z.array(z.object({ id: z.string().optional(), patch })).max(1000).optional(),
}).strict();
export type ChangeBatch = z.infer<typeof batchSchema>;
export const commandSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  operationId: z.string().min(1).max(128),
  action: z.enum(['updateEntity', 'updateActivities', 'updateActivityPatches', 'pasteActivities',
    'addActivity', 'duplicateSelection', 'deleteSelection', 'connect', 'newScenario', 'renameScenario',
    'removeScenario', 'baseline', 'manageBaseline', 'finishEdit', 'undo', 'redo', 'setTagCatalog', 'applyChanges', 'saveCompleted', 'replaceDocument']),
  args: z.array(z.unknown()).max(10),
  scenarioId: z.string().optional(),
  selection: z.object({ activityIds: z.array(z.string()).max(1000), dependencyId: z.string().optional() }).strict().optional(),
}).strict();
export type PlannerCommand = z.infer<typeof commandSchema>;
export class ServiceError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
