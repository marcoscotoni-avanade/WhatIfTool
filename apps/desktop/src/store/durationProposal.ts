import type { Activity, ProjectSnapshot } from '@planner/domain';
import { nominalDayHours } from '@planner/scheduling';

export interface DurationProposal {
  activityId: string; code: string; previousDuration: number; durationUnit: Activity['durationUnit'];
  duration?: number; calendarId?: string; calendarName?: string; allocationPercent?: number; reason?: string;
}

export function proposeDuration(model: ProjectSnapshot, activity: Activity): DurationProposal {
  const proposal: DurationProposal = { activityId: activity.id, code: activity.code, previousDuration: activity.duration, durationUnit: activity.durationUnit };
  if (activity.type === 'MILESTONE') return { ...proposal, reason: 'Milestones always have zero duration.' };
  if (activity.elapsedMode) return { ...proposal, reason: 'Elapsed activities require a manually entered duration.' };
  const member = activity.ownerId ? model.project.team?.members.find(m => m.id === activity.ownerId) : undefined;
  if (activity.ownerId && !member) return { ...proposal, reason: 'The activity owner is not in the team.' };
  const allocation = member?.allocationPercent ?? 100;
  if (allocation <= 0) return { ...proposal, allocationPercent: allocation, reason: 'Allocation is 0%; duration cannot be calculated.' };
  const calendarId = member ? model.project.team!.calendarId : model.project.defaultCalendarId;
  const calendar = model.calendars.find(c => c.id === calendarId);
  if (!calendar || nominalDayHours(calendar) <= 0) return { ...proposal, reason: 'A valid working calendar is required.' };
  const hours = activity.effortHours / (allocation / 100);
  const duration = activity.durationUnit === 'h' ? hours : hours / nominalDayHours(calendar);
  if (!Number.isFinite(duration)) return { ...proposal, reason: 'The calculated duration is too large.' };
  return { ...proposal, duration, calendarId, calendarName: calendar.name, allocationPercent: allocation };
}
