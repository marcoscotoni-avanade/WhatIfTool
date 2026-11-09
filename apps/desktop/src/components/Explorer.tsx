import { useProjectStore } from '../store/useProjectStore';
import { displayDate, num, signed, useResolved } from './shared';

export function Explorer({ openRecent, projectSettings }: { openRecent: () => void; projectSettings: () => void }) {
  const m = useResolved(), s = useProjectStore(), milestone = m.activities.find(a => a.id === s.activeMilestoneId);
  const result = milestone ? s.results?.schedule.activities[milestone.id] : undefined;
  const target = milestone?.targetDate ?? m.project.targetFinish;
  const impact = s.results?.milestoneImpact?.activityId === milestone?.id ? s.results?.milestoneImpact : undefined;
  return <aside className="explorer"><div className="explorer-title">{milestone ? 'MILESTONE ANALYSIS' : 'PROJECT EXPLORER'}</div>
    <button className="project-card" onClick={projectSettings}><strong>{m.project.name}</strong><small>{m.activities.length} activities · {m.dependencies.length} dependencies</small><span>Edit project & calendars</span></button>
    <button className="text-button" onClick={openRecent}>Open recent project</button>
    <h3>Scenarios</h3><button className={`explorer-item ${!s.activeScenarioId ? 'active' : ''}`} onClick={() => s.activateScenario()}>Working draft <small>editable</small></button>
    {Object.values(s.document.scenariosById).map(scenario => <button key={scenario.id} className={`explorer-item ${s.activeScenarioId === scenario.id ? 'active' : ''}`} onClick={() => s.activateScenario(scenario.id)}>
      {scenario.isBaseline ? '[B] ' : '[S] '}{scenario.name}<small>{scenario.isBaseline ? 'published / immutable' : scenario.parentScenarioId ? 'inherited scenario' : 'copy-on-write'}</small>
    </button>)}
    <h3>Milestones</h3>{m.activities.filter(a => a.type === 'MILESTONE').map(a => <button className={`explorer-item ${s.activeMilestoneId === a.id ? 'active' : ''}`} key={a.id}
      onClick={() => { s.select([a.id]); useProjectStore.setState({ activeMilestoneId: a.id }); }}>
      {'<> '}{a.name}<small>{displayDate(s.results?.schedule.activities[a.id]?.calculatedFinish)} · Risk {num(s.results?.risk[a.id]?.totalRisk)}</small>
    </button>)}
    {!m.activities.some(a => a.type === 'MILESTONE') && <small className="muted">Create a milestone to focus on its upstream network.</small>}
    {milestone && <section className="milestone-focus"><div className="focus-heading"><h3>Milestone Focus</h3><button title="Clear focus" onClick={() => useProjectStore.setState({ activeMilestoneId: undefined })}>X</button></div>
      <strong>{milestone.name}</strong><dl><dt>Target</dt><dd>{displayDate(target)}</dd><dt>Calculated</dt><dd>{displayDate(result?.calculatedFinish)}</dd>
        <dt>Schedule delta</dt><dd className={target && result && Date.parse(result.calculatedFinish) > Date.parse(target) ? 'negative' : ''}>
          {impact?.scheduleDelta !== undefined ? `${signed(impact.scheduleDelta)}d` : '--'}</dd>
        <dt>Risk Exposure</dt><dd className="focus-score">{num(s.results?.risk[milestone.id]?.totalRisk)}</dd></dl>
      <h4>Mitigation priority</h4>
      {s.calculationStatus === 'calculating' && <small>Calculating marginal contributions...</small>}
      {s.results?.milestoneContributors?.slice(0, 10).map(c => <button className="rank-item" key={c.activityId} onClick={() => s.select([c.activityId])}>
        <span>{c.rank}. {m.activities.find(a => a.id === c.activityId)?.name}</span><b>{num(c.contribution)}</b></button>)}
      <small>Score decrease when this ancestor's risk is neutralized. Not additive; dates remain unchanged.</small>
    </section>}
    <div className="explorer-foot">LOCAL FIRST<br /><small>No account. No cloud. No telemetry.</small></div>
  </aside>;
}
