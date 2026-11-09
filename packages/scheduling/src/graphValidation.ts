import type { Dependency, ProjectSnapshot } from '@planner/domain';
import { validateProject } from '@planner/domain';

export function topologicalSort(m: ProjectSnapshot): string[] {
  validateProject(m);
  const degree = new Map(m.activities.map(a => [a.id, 0])), out = new Map<string, string[]>();
  for (const d of m.dependencies) {
    degree.set(d.successorId, degree.get(d.successorId)! + 1);
    out.set(d.predecessorId, [...out.get(d.predecessorId) ?? [], d.successorId]);
  }
  const result = [...degree].filter(([, n]) => n === 0).map(([id]) => id);
  for (let i = 0; i < result.length; i++) for (const id of out.get(result[i]!) ?? []) {
    degree.set(id, degree.get(id)! - 1);
    if (degree.get(id) === 0) result.push(id);
  }
  return result;
}
function traverse(id: string, deps: Dependency[], reverse: boolean): Set<string> {
  const adjacency = new Map<string, string[]>();
  for (const d of deps) {
    const a = reverse ? d.successorId : d.predecessorId, b = reverse ? d.predecessorId : d.successorId;
    adjacency.set(a, [...adjacency.get(a) ?? [], b]);
  }
  const seen = new Set<string>(), queue = [id];
  for (let i = 0; i < queue.length; i++) for (const next of adjacency.get(queue[i]!) ?? [])
    if (next !== id && !seen.has(next)) { seen.add(next); queue.push(next); }
  return seen;
}
export const getAncestors = (id: string, deps: Dependency[]) => traverse(id, deps, true);
export const getDescendants = (id: string, deps: Dependency[]) => traverse(id, deps, false);
export const getAffectedSubgraph = (ids: string[], deps: Dependency[]) => new Set(ids.flatMap(id => [id, ...getDescendants(id, deps)]));
export function detectCycle(m: ProjectSnapshot): boolean {
  try { topologicalSort(m); return false; } catch (error) {
    if (error instanceof Error && error.message.includes('cycle')) return true;
    throw error;
  }
}
