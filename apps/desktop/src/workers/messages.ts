import type { CalculationResults, ProjectModel, ScenarioComparison } from '@planner/domain';
export interface CalculationRequest {
  type: 'CALCULATE_PROJECT' | 'CALCULATE_SCENARIO' | 'CALCULATE_MILESTONE' | 'COMPARE_SCENARIOS';
  requestId: number; revision: number; model: ProjectModel; scenarioId?: string; milestoneId?: string;
}
export type CalculationResponse =
  | { type: 'RESULT'; requestId: number; revision: number; results: CalculationResults }
  | { type: 'COMPARISON'; requestId: number; revision: number; comparison: ScenarioComparison }
  | { type: 'ERROR'; requestId: number; revision: number; message: string };
