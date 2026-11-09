import type { CalculationResults, MilestoneContributor, ProjectSnapshot, RiskExplanation, ScheduleResults } from '@planner/domain';
import { activityCalendar, edgeSlack, getAncestors, workingDurationBetween } from '@planner/scheduling';

export const RISK_ENGINE_VERSION = '1.0.0';
const clamp = (n: number) => Math.max(0, Math.min(1, n));
export const noisyOr = (values: number[]) => clamp(1 - values.reduce((product, n) => product * (1 - clamp(n)), 1));
function riskCalculator(m: ProjectSnapshot, schedule: ScheduleResults) {
  const byId = new Map(m.activities.map(a => [a.id, a]));
  const incoming = new Map<string, typeof m.dependencies>();
  const outgoing = new Map<string, string[]>();
  for (const d of m.dependencies) incoming.set(d.successorId, [...incoming.get(d.successorId) ?? [], d]);
  for (const d of m.dependencies) outgoing.set(d.predecessorId, [...outgoing.get(d.predecessorId) ?? [], d.successorId]);
  const settings = m.settings, H = settings.defaultImpactHorizon;
  // Schedule-dependent factors are shared across counterfactual mitigations; only exposure propagates again.
  const factors = new Map(m.dependencies.map(d => {
    const p = byId.get(d.predecessorId)!, ps = schedule.activities[p.id]!;
    const currentDrift = p.plannedFinish ? Math.max(0, workingDurationBetween(p.plannedFinish, ps.calculatedFinish, activityCalendar(m, p))) : 0;
    const availableSlack = edgeSlack(d, m, schedule, byId.get(d.successorId)!);
    const spill = Math.max(0, currentDrift + (p.delayP80 ?? 0) - availableSlack);
    return [d.id, { currentDrift, availableSlack, spill, pressure: 1 - Math.exp(-spill / H) }];
  }));
  return (neutralizedId?: string, baseline?: Record<string, RiskExplanation>): Record<string, RiskExplanation> => {
    const result: Record<string, RiskExplanation> = baseline ? { ...baseline } : {};
    Object.setPrototypeOf(result, null);
    const affected = new Set<string>();
    if (neutralizedId && baseline) {
      const queue = [neutralizedId]; affected.add(neutralizedId);
      for (let i = 0; i < queue.length; i++) for (const id of outgoing.get(queue[i]!) ?? [])
        if (!affected.has(id)) { affected.add(id); queue.push(id); }
    }
    for (const id of schedule.order) {
      if (baseline && !affected.has(id)) continue;
      const a = byId.get(id)!, sr = schedule.activities[id]!;
      const conflictRisk = id === neutralizedId ? 0 : clamp(Math.max(0, ...sr.violations.map(v => v.deltaDays ?? 0)) / H);
      const intrinsic = id === neutralizedId ? 0 : Math.max(conflictRisk,
        a.intrinsicRisk !== undefined ? a.intrinsicRisk / 100 : (a.probabilityOfDelay ?? 0) * Math.min(1, (a.delayP80 ?? 0) / H));
      const contributors = (incoming.get(id) ?? []).map(d => {
        const p = byId.get(d.predecessorId)!;
        const predecessorRisk = result[p.id]!.totalRisk / 100;
        const probabilityOfDelay = p.id === neutralizedId ? 0 : p.probabilityOfDelay ?? 0;
        const { currentDrift, availableSlack, spill, pressure } = factors.get(d.id)!;
        const gate = predecessorRisk >= settings.riskThreshold ? predecessorRisk : 0;
        const transmission = Math.min(settings.transmissionCap, settings.defaultDamping * (d.edgeWeight ?? 1) * probabilityOfDelay * gate * pressure);
        return { dependencyId: d.id, predecessorId: p.id, predecessorRisk: predecessorRisk * 100, probabilityOfDelay,
          delayP80: p.delayP80 ?? 0, currentDrift, availableSlack, spill, pressure,
          damping: settings.defaultDamping, transmittedRisk: clamp(transmission) * 100 };
      });
      const propagated = noisyOr(contributors.map(c => c.transmittedRisk / 100));
      result[id] = { activityId: id, intrinsicRisk: intrinsic * 100, conflictRisk: conflictRisk * 100,
        propagatedRisk: propagated * 100, totalRisk: noisyOr([intrinsic, propagated]) * 100, contributors };
    }
    return result;
  };
}
export function calculateRisk(m: ProjectSnapshot, schedule: ScheduleResults, neutralizedId?: string): Record<string, RiskExplanation> {
  return riskCalculator(m, schedule)(neutralizedId);
}
export function analyzeMilestoneContributors(m: ProjectSnapshot, schedule: ScheduleResults, milestoneId: string): MilestoneContributor[] {
  const calculate = riskCalculator(m, schedule), original = calculate(), baseline = original[milestoneId];
  if (!baseline) throw new Error('Milestone not found.');
  return [...getAncestors(milestoneId, m.dependencies)].map(activityId => ({
    activityId, contribution: Math.max(0, baseline.totalRisk - calculate(activityId, original)[milestoneId]!.totalRisk), rank: 0,
  })).sort((a, b) => b.contribution - a.contribution || a.activityId.localeCompare(b.activityId)).map((c, i) => ({ ...c, rank: i + 1 }));
}
export function calculateProjectRisk(m: ProjectSnapshot, schedule: ScheduleResults, milestoneId?: string): CalculationResults {
  const milestone = milestoneId ? m.activities.find(a => a.id === milestoneId) : undefined;
  const target = milestone?.targetDate ?? m.project.targetFinish;
  const finish = milestoneId ? schedule.activities[milestoneId]?.calculatedFinish : undefined;
  return { schedule, risk: calculateRisk(m, schedule), riskEngineVersion: RISK_ENGINE_VERSION,
    milestoneId, milestoneContributors: milestoneId ? analyzeMilestoneContributors(m, schedule, milestoneId) : undefined,
    milestoneImpact: milestone && finish ? { activityId: milestone.id, targetDate: target, calculatedFinish: finish,
      scheduleDelta: target ? workingDurationBetween(target, finish, activityCalendar(m, milestone)) : undefined } : undefined };
}
