import type { CalculationRequest, CalculationResponse } from './messages';
import { toModel } from '../store/document';
import { useProjectStore } from '../store/useProjectStore';
let worker: Worker | undefined, sequence = 0, latestCalculation = 0, latestComparison = 0;
function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./calculation.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data: r }: MessageEvent<CalculationResponse>) => {
      const state = useProjectStore.getState();
      if (r.revision !== state.revision) return;
      if (r.type === 'RESULT' && r.requestId === latestCalculation && r.results.scenarioId === state.activeScenarioId
        && r.results.milestoneId === state.activeMilestoneId) useProjectStore.setState({ results: r.results, calculationStatus: 'ready' });
      if (r.type === 'COMPARISON' && r.requestId === latestComparison) useProjectStore.setState({ comparison: r.comparison });
      if (r.type === 'ERROR' && (r.requestId === latestCalculation || r.requestId === latestComparison)) {
        useProjectStore.setState({ calculationStatus: 'error' }); state.report(r.message);
      }
    };
    worker.onerror = event => {
      useProjectStore.getState().report(`Calculation worker failed: ${event.message}`);
      useProjectStore.setState({ calculationStatus: 'error' });
      worker?.terminate(); worker = undefined;
    };
  }
  return worker;
}
export function requestCalculation(compare = false): void {
  const s = useProjectStore.getState(), requestId = ++sequence;
  if (compare) latestComparison = requestId; else {
    latestCalculation = requestId; useProjectStore.setState({ calculationStatus: 'calculating' });
  }
  const request: CalculationRequest = {
    type: compare ? 'COMPARE_SCENARIOS' : s.activeMilestoneId ? 'CALCULATE_MILESTONE' : s.activeScenarioId ? 'CALCULATE_SCENARIO' : 'CALCULATE_PROJECT',
    requestId, revision: s.revision, model: toModel(s.document), scenarioId: s.activeScenarioId, milestoneId: s.activeMilestoneId,
  };
  try { getWorker().postMessage(request); } catch (error) { s.report(error); useProjectStore.setState({ calculationStatus: 'error' }); }
}
