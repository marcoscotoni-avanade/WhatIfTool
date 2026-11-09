import type { Calendar, DurationUnit } from '@planner/domain';

const HOUR = 3_600_000, DAY = 24 * HOUR, MAX_DAYS = 366_000;
const time = (value: string | number) => {
  const n = typeof value === 'number' ? value : Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T09:00:00Z` : value);
  if (!Number.isFinite(n)) throw new Error(`Invalid calendar instant: ${value}`);
  return n;
};
const midnight = (t: number) => Math.floor(t / DAY) * DAY;
const minutes = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
export function nominalDayHours(c: Calendar): number {
  return c.workingIntervals.reduce((sum, i) => sum + (minutes(i.end) - minutes(i.start)) / 60, 0);
}
function intervals(day: number, c: Calendar): [number, number][] {
  const date = new Date(day).toISOString().slice(0, 10);
  const exception = c.exceptions.find(e => e.date === date);
  const list = exception ? exception.intervals : c.holidays.includes(date) || !c.workingDays.includes(new Date(day).getUTCDay()) ? [] : c.workingIntervals;
  return list.map(i => [day + minutes(i.start) * 60_000, day + minutes(i.end) * 60_000]);
}
export function isWorkingTime(value: string | number, c: Calendar): boolean {
  const t = time(value);
  return intervals(midnight(t), c).some(([s, e]) => s <= t && t < e);
}
export function nextWorkingInstant(value: string | number, c: Calendar): string {
  let t = time(value);
  for (let n = 0; n < MAX_DAYS; n++) {
    for (const [s, e] of intervals(midnight(t), c)) if (t < e) return new Date(Math.max(t, s)).toISOString();
    t = midnight(t) + DAY;
  }
  throw new Error('Calendar has no reachable working instant within 1,000 years.');
}
export function previousWorkingInstant(value: string | number, c: Calendar): string {
  let t = time(value);
  for (let n = 0; n < MAX_DAYS; n++) {
    for (const [s, e] of intervals(midnight(t), c).reverse()) if (t > s) return new Date(Math.min(t, e)).toISOString();
    t = midnight(t) - 1;
  }
  throw new Error('Calendar has no reachable previous working instant.');
}
export function addWorkingDuration(value: string | number, duration: number, unit: DurationUnit, c: Calendar, elapsed = false): string {
  if (!Number.isFinite(duration)) throw new Error('Duration must be finite.');
  let t = time(value);
  let remaining = Math.abs(duration) * HOUR * (unit === 'h' ? 1 : elapsed ? 24 : nominalDayHours(c));
  if (elapsed || remaining === 0) return new Date(t + Math.sign(duration) * remaining).toISOString();
  const forward = duration > 0;
  for (let count = 0; count < MAX_DAYS * 10; count++) {
    t = time(forward ? nextWorkingInstant(t, c) : previousWorkingInstant(t, c));
    const list = intervals(midnight(t), c);
    const interval = list.find(([s, e]) => forward ? s <= t && t < e : s < t && t <= e);
    if (!interval) throw new Error('Calendar interval could not be resolved.');
    const available = forward ? interval[1] - t : t - interval[0];
    if (remaining <= available + .001) return new Date(t + (forward ? remaining : -remaining)).toISOString();
    remaining -= available;
    t = forward ? interval[1] : interval[0];
  }
  throw new Error('Duration exceeds supported calendar range.');
}
export const subtractWorkingDuration = (value: string | number, duration: number, unit: DurationUnit, c: Calendar, elapsed = false) =>
  addWorkingDuration(value, -duration, unit, c, elapsed);
export function workingDurationBetween(start: string | number, finish: string | number, c: Calendar, elapsed = false): number {
  const a = time(start), b = time(finish);
  if (elapsed) return (b - a) / DAY;
  if (a > b) return -workingDurationBetween(b, a, c);
  if (b - a > MAX_DAYS * DAY) throw new Error('Date range exceeds 1,000 years.');
  let total = 0;
  for (let day = midnight(a); day <= midnight(b); day += DAY)
    for (const [s, e] of intervals(day, c)) total += Math.max(0, Math.min(b, e) - Math.max(a, s));
  return total / (HOUR * nominalDayHours(c));
}
