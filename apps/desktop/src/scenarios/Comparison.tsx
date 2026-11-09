import { useProjectStore } from '../store/useProjectStore';
import { Modal, displayDate, num, signed, useResolved } from '../components/shared';

export function Comparison({ close }: { close: () => void }) {
  const s = useProjectStore(), m = useResolved(), c = s.comparison;
  const id = s.activeMilestoneId, b = c?.baseline, r = c?.scenario;
  const aggregateRisk = (risk?: typeof b) => id ? risk?.risk[id]?.totalRisk : Math.max(0, ...Object.values(risk?.risk ?? {}).map(v => v.totalRisk));
  const critical = (result?: typeof b) => Object.values(result?.schedule.activities ?? {}).filter(a => a.critical).length;
  const negative = (result?: typeof b) => Math.min(0, ...Object.values(result?.schedule.activities ?? {}).map(a => a.totalSlack));
  return <Modal title="Scenario comparison" close={close} wide>
    <p>Published baseline vs <strong>{s.document.scenariosById[s.activeScenarioId ?? '']?.name}</strong>. {id ? `Focus: ${m.activities.find(a => a.id === id)?.name}` : 'Project summary (risk = maximum activity exposure).'}</p>
    {!c ? <p>{s.calculationStatus === 'error' ? s.error : 'Calculating comparison in background...'}</p> : <>
      <table className="comparison-table"><thead><tr><th>Metric</th><th>Baseline</th><th>Scenario</th><th>Delta</th></tr></thead><tbody>
        <tr><td>{id ? 'Milestone finish' : 'Project finish'}</td><td>{displayDate(id ? b?.schedule.activities[id]?.calculatedFinish : b?.schedule.projectFinish)}</td><td>{displayDate(id ? r?.schedule.activities[id]?.calculatedFinish : r?.schedule.projectFinish)}</td><td>{signed(c.finishDelta)}d</td></tr>
        <tr><td>Risk Exposure Score</td><td>{num(aggregateRisk(b))}</td><td>{num(aggregateRisk(r))}</td><td>{signed(c.riskDelta)}</td></tr>
        <tr><td>Critical activities</td><td>{critical(b)}</td><td>{critical(r)}</td><td>{signed(c.criticalDelta)}</td></tr>
        <tr><td>Negative slack</td><td>{num(negative(b))}d</td><td>{num(negative(r))}d</td><td>{signed(c.negativeSlackDelta)}d</td></tr>
      </tbody></table>
      <h3>Activity changes</h3><div className="table-scroll"><table className="comparison-table"><thead><tr><th>Activity</th><th>Duration</th><th>Start</th><th>Finish</th><th>Slack</th><th>Risk</th><th>Critical path</th></tr></thead><tbody>
        {c.activities.map(a => <tr key={a.activityId}><td>{m.activities.find(x => x.id === a.activityId)?.name ?? a.activityId}</td>
          {a.added || a.removed ? <td colSpan={6}>{a.added ? 'Added in scenario' : 'Removed in scenario'}</td> : <>
            <td>{signed(a.durationDelta)}d</td><td>{signed(a.startDelta)}d</td><td>{signed(a.finishDelta)}d</td><td>{signed(a.slackDelta)}d</td><td>{signed(a.riskDelta)}</td><td>{a.criticalChanged ? 'Changed' : '-'}</td></>}</tr>)}
      </tbody></table></div>{!c.activities.length && <p>No calculated differences from baseline.</p>}
    </>}
  </Modal>;
}
