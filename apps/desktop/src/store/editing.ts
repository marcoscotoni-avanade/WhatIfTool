import { iso, type Activity } from '@planner/domain';
export const editableActivityFields = new Set([
  'code', 'name', 'description', 'type', 'effortHours', 'duration', 'durationUnit', 'elapsedMode', 'scheduleMode',
  'plannedStart', 'plannedFinish', 'actualStart', 'actualFinish', 'constraintType', 'constraintDate', 'targetDate',
  'intrinsicRisk', 'probabilityOfDelay', 'delayP80', 'calendarId', 'status',
]);
const numeric = new Set(['duration', 'effortHours', 'intrinsicRisk', 'probabilityOfDelay', 'delayP80']);
const dates = new Set(['plannedStart', 'plannedFinish', 'actualStart', 'actualFinish', 'constraintDate', 'targetDate']);
export function activityPatch(field: string, value: unknown, activity: Activity, defaultStart: string): Partial<Activity> {
  if (!editableActivityFields.has(field)) throw new Error(`Field is read-only: ${field}`);
  const text = value === undefined || value === null ? '' : String(value);
  let parsed: unknown = text;
  if (numeric.has(field)) parsed = text === '' && !['duration', 'effortHours'].includes(field) ? undefined : Number(text);
  if (dates.has(field)) parsed = text ? iso(text) : undefined;
  if (field === 'elapsedMode') {
    if (![true, false, 'true', 'false'].includes(value as string | boolean)) throw new Error('Elapsed mode must be true or false.');
    parsed = value === true || value === 'true';
  }
  if (['constraintType', 'calendarId'].includes(field) && !text) parsed = undefined;
  const patch: Partial<Activity> = {};
  Reflect.set(patch, field, parsed);
  if (field === 'type' && value === 'MILESTONE') patch.duration = 0;
  if (field === 'scheduleMode' && value === 'MANUAL' && !activity.plannedStart && !activity.plannedFinish) patch.plannedStart = defaultStart;
  if (field === 'constraintType' && value && value !== 'ASAP' && !activity.constraintDate) patch.constraintDate = defaultStart;
  return patch;
}
