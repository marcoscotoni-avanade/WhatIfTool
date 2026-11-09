import { beforeEach, expect, it } from 'vitest';
import { scheduleProject } from '@planner/scheduling';
import { createScenario, resolveScenario } from '@planner/scenarios';
import { fixture } from '../helpers';
import { useProjectStore as store } from '../../apps/desktop/src/store/useProjectStore';
import { toModel } from '../../apps/desktop/src/store/document';
import { proposeDuration } from '../../apps/desktop/src/store/durationProposal';

const model = () => toModel(store.getState().document);
const team = { name: 'Team', calendarId: 'standard', members: [{ id: 'marco', name: 'Marco', allocationPercent: 50 }] };
beforeEach(() => {
  const m = fixture(); m.project.team = structuredClone(team);
  m.activities[0]!.ownerId = 'marco'; m.activities[0]!.effortHours = 40;
  m.activities[1]!.ownerId = 'marco'; m.activities[1]!.effortHours = 16;
  store.getState().load(m);
});

it('calculates working days and hours, and explains unsupported activities', () => {
  const m = model(), a = m.activities[0]!;
  expect(proposeDuration(m, a).duration).toBe(10);
  expect(proposeDuration(m, { ...a, durationUnit: 'h' }).duration).toBe(80);
  expect(proposeDuration(m, { ...a, ownerId: undefined }).duration).toBe(5);
  expect(proposeDuration(m, { ...a, elapsedMode: true }).reason).toMatch(/Elapsed/);
  expect(proposeDuration(m, { ...a, type: 'MILESTONE' }).reason).toMatch(/Milestone/);
  m.project.team!.members[0]!.allocationPercent = 0;
  expect(proposeDuration(m, a).reason).toMatch(/0%/);
});

it('asks on effort, accepts or keeps durations atomically, supports undo and cancellation', () => {
  const oldFinish = scheduleProject(model()).activities['0']!.calculatedFinish;
  store.getState().updateActivities(['0'], { effortHours: 48 });
  expect(model().activities[0]!.effortHours).toBe(40);
  expect(store.getState().pendingEdit!.proposals[0]!.duration).toBe(12);
  store.getState().finishEdit(['0']);
  expect(model().activities[0]).toMatchObject({ effortHours: 48, duration: 12, calendarId: 'standard' });
  expect(Date.parse(scheduleProject(model()).activities['0']!.calculatedFinish)).toBeGreaterThan(Date.parse(oldFinish));
  store.getState().undo();
  expect(model().activities[0]).toMatchObject({ effortHours: 40, duration: 2 });
  store.getState().redo();
  store.getState().updateActivities(['0'], { effortHours: 56 });
  store.getState().finishEdit([]);
  expect(model().activities[0]).toMatchObject({ effortHours: 56, duration: 12 });
  store.getState().updateActivities(['0'], { effortHours: 64 });
  store.getState().finishEdit();
  expect(model().activities[0]!.effortHours).toBe(56);
});

it('proposes one batch for allocation changes, applies only selected activities', () => {
  const updated = structuredClone(team); updated.members[0]!.allocationPercent = 25;
  store.getState().updateEntity('project', model().project.id, { team: updated });
  expect(store.getState().pendingEdit!.proposals.map(p => p.duration)).toEqual([20, 8]);
  store.getState().finishEdit(['0']);
  expect(model().project.team!.members[0]!.allocationPercent).toBe(25);
  expect(model().activities.map(a => a.duration)).toEqual([20, 1]);
  store.getState().undo();
  expect(model().project.team!.members[0]!.allocationPercent).toBe(50);
  expect(model().activities.map(a => a.duration)).toEqual([2, 1]);
});

it('freezes old calendar for excluded activities when a shared calendar changes', () => {
  const before = model(); before.dependencies = [];
  const originalFinish = scheduleProject(before).activities['1']!.calculatedFinish;
  store.getState().updateEntity('calendar', 'standard', { workingIntervals: [{ start: '09:00', end: '13:00' }] });
  expect(store.getState().pendingEdit!.proposals.map(p => p.duration)).toEqual([20, 8]);
  store.getState().finishEdit(['0']);
  const m = model();
  expect(m.activities[0]!.calendarId).toBe('standard');
  expect(m.activities[1]!.calendarId).not.toBe('standard');
  expect(m.calendars.find(c => c.id === m.activities[1]!.calendarId)!.workingIntervals[0]!.end).toBe('17:00');
  expect(scheduleProject({ ...m, dependencies: [] }).activities['1']!.calculatedFinish)
    .toBe(originalFinish);
});

it('isolates team and duration overrides in a scenario and preserves its baseline', () => {
  const created = createScenario(model(), 'Scenario');
  store.getState().load(created.model); store.getState().activateScenario(created.id);
  const updated = structuredClone(team); updated.members[0]!.allocationPercent = 25;
  store.getState().updateEntity('project', model().project.id, { team: updated });
  store.getState().finishEdit(['0']);
  const result = model();
  expect(result.project.team!.members[0]!.allocationPercent).toBe(50);
  expect(result.baselines[0]!.snapshot.project.team!.members[0]!.allocationPercent).toBe(50);
  expect(resolveScenario(result, created.id).project.team!.members[0]!.allocationPercent).toBe(25);
  expect(resolveScenario(result, created.id).activities[0]!.duration).toBe(20);
});

it('preserves the historical calendar when a scenario changes it', () => {
  const created = createScenario(model(), 'Scenario');
  store.getState().load(created.model); store.getState().activateScenario(created.id);
  store.getState().updateEntity('calendar', 'standard', { workingIntervals: [{ start: '09:00', end: '13:00' }] });
  store.getState().finishEdit(['0']);
  const m = model(), scenario = resolveScenario(m, created.id);
  expect(m.baselines[0]!.snapshot.calendars[0]!.workingIntervals[0]!.end).toBe('17:00');
  expect(scenario.calendars.find(c => c.id === scenario.activities[1]!.calendarId)!.workingIntervals[0]!.end).toBe('17:00');
  expect(scenario.calendars.find(c => c.id === scenario.activities[0]!.calendarId)!.workingIntervals[0]!.end).toBe('13:00');
});

it('preserves implicit old calendars when the project default changes', () => {
  const m = model();
  m.calendars.push({ ...structuredClone(m.calendars[0]!), id: 'short', name: 'Short', workingIntervals: [{ start: '09:00', end: '13:00' }] });
  m.activities.forEach(a => { a.ownerId = undefined; });
  store.getState().load(m);
  store.getState().updateEntity('project', m.project.id, { defaultCalendarId: 'short' });
  expect(store.getState().pendingEdit!.proposals.map(p => p.duration)).toEqual([10, 4]);
  store.getState().finishEdit(['0']);
  expect(model().activities[0]!.calendarId).toBe('short');
  expect(model().activities[1]!.calendarId).toBe('standard');
});

it('preserves explicitly supplied durations in a batch unless selected in the preview', () => {
  store.getState().updateActivityPatches([
    { id: '0', patch: { effortHours: 48, duration: 7 } },
    { id: '1', patch: { effortHours: 24 } },
  ]);
  expect(store.getState().pendingEdit!.proposals.map(p => p.duration)).toEqual([12, 6]);
  store.getState().finishEdit(['1']);
  expect(model().activities.map(a => a.duration)).toEqual([7, 6]);
});

it('rejects removing a referenced owner and reports zero allocation without changing duration', () => {
  store.getState().updateEntity('project', model().project.id, { team: { ...team, members: [] } });
  expect(store.getState().error).toMatch(/owner/);
  expect(model().project.team!.members).toHaveLength(1);
  const updated = structuredClone(team); updated.members[0]!.allocationPercent = 0;
  store.getState().updateEntity('project', model().project.id, { team: updated });
  expect(store.getState().pendingEdit!.proposals[0]!.reason).toMatch(/0%/);
  store.getState().finishEdit([]);
  expect(model().activities[0]!.duration).toBe(2);
});

it('rejects invalid allocations and preserves durations for elapsed activities', () => {
  const invalid = structuredClone(team); invalid.members[0]!.allocationPercent = 101;
  store.getState().updateEntity('project', model().project.id, { team: invalid });
  expect(store.getState().error).toMatch(/allocation/);
  expect(model().project.team!.members[0]!.allocationPercent).toBe(50);
  store.getState().updateActivities(['0'], { elapsedMode: true });
  store.getState().updateActivities(['0'], { effortHours: 48 });
  expect(store.getState().pendingEdit!.proposals[0]!.reason).toMatch(/Elapsed/);
  store.getState().finishEdit([]);
  expect(model().activities[0]).toMatchObject({ effortHours: 48, duration: 2, elapsedMode: true });
});
