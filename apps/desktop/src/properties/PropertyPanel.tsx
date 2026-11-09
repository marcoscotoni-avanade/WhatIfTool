import { iso, type Activity } from '@planner/domain';
import { useProjectStore } from '../store/useProjectStore';
import { activityPatch } from '../store/editing';
import { Field, fullDate, num, useResolved } from '../components/shared';

export function PropertyPanel() {
  const m = useResolved(), s = useProjectStore();
  const a = m.activities.find(a => a.id === s.selectedActivityIds[0]);
  const d = m.dependencies.find(d => d.id === s.selectedDependencyId);
  const immutable = !!s.activeScenarioId && !!s.document.scenariosById[s.activeScenarioId]?.isBaseline;
  if (d) return <aside className="properties"><h2>Dependency</h2><p>{m.activities.find(a => a.id === d.predecessorId)?.code} -&gt; {m.activities.find(a => a.id === d.successorId)?.code}</p>
    <Field label="Dependency type" value={d.type} options={['FS', 'SS', 'FF', 'SF']} disabled={immutable} onCommit={value => s.updateEntity('dependency', d.id, { type: value })} />
    <Field label="Lag / lead" type="number" value={d.lag} disabled={immutable} onCommit={value => s.updateEntity('dependency', d.id, { lag: Number(value) })} />
    <Field label="Lag unit" value={d.lagUnit} options={['d', 'h']} disabled={immutable} onCommit={value => s.updateEntity('dependency', d.id, { lagUnit: value })} />
    <Field label="Edge weight" type="number" min={0} max={1} value={d.edgeWeight ?? 1} disabled={immutable} onCommit={value => s.updateEntity('dependency', d.id, { edgeWeight: Number(value) })} />
    <button className="danger" disabled={immutable} onClick={s.deleteSelection}>Delete dependency</button></aside>;
  if (!a) return <aside className="properties"><h2>Inspector</h2><div className="empty-panel"><b>Explain the plan.</b><p>Select an activity to inspect dates, slack and risk factors. Select an edge to configure its dependency.</p><p>Choose GO LIVE in the explorer and activate Milestone Focus to rank mitigation opportunities.</p></div></aside>;
  const schedule = s.results?.schedule.activities[a.id], risk = s.results?.risk[a.id];
  const update = (field: string, value: string) => {
    try { s.updateActivities(s.selectedActivityIds.length > 1 ? s.selectedActivityIds : [a.id], activityPatch(field, value, a, schedule?.calculatedStart ?? m.project.projectStart)); }
    catch (error) { s.report(error); }
  };
  const input = (label: string, field: keyof Activity, type = 'text', options?: string[]) => <Field label={label} value={typeof a[field] === 'string' || typeof a[field] === 'number' ? a[field] as string | number : ''}
    type={type} options={options} disabled={immutable} onCommit={value => update(field, value)} />;
  const dateInput = (label: string, field: 'plannedStart' | 'plannedFinish' | 'actualStart' | 'actualFinish' | 'constraintDate' | 'targetDate') =>
    <Field label={label} type="datetime-local" value={a[field]?.slice(0, 16)} disabled={immutable} onCommit={value => update(field, value ? iso(`${value}Z`) : '')} />;
  const overrides = s.document.overrides.filter(o => o.scenarioId === s.activeScenarioId && o.entityId === a.id);
  return <aside className="properties"><div className="inspector-heading"><h2>{a.code}</h2><span>{s.selectedActivityIds.length > 1 ? `${s.selectedActivityIds.length} selected` : a.type}</span></div>
    {immutable && <p className="info-box">Published baseline is read-only. Create or clone a scenario to experiment.</p>}
    <details open><summary>General</summary>{input('Activity code', 'code')}{input('Activity name', 'name')}{input('Description', 'description')}
      {input('Activity type', 'type', 'text', ['TASK', 'MILESTONE', 'SUMMARY'])}
      {input('Status', 'status', 'text', ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETE'])}</details>
    <details open><summary>Scheduling <small>UTC</small></summary><div className="field-pair">{input('Effort (hours)', 'effortHours', 'number')}{input('Duration', 'duration', 'number')}</div>
      <Field label="Owner" value={a.ownerId ?? ''} options={[{ value: '', label: 'No owner (project calendar, 100%)' }, ...(m.project.team?.members ?? []).map(member => ({ value: member.id, label: `${member.name} (${member.allocationPercent}%)` }))]} disabled={immutable} onCommit={value => update('ownerId', value)} />
      <div className="field-pair">{input('Duration unit', 'durationUnit', 'text', ['d', 'h'])}{input('Schedule mode', 'scheduleMode', 'text', ['AUTO', 'MANUAL'])}</div>
      <Field label="Calendar" value={a.calendarId ?? m.project.defaultCalendarId} options={m.calendars.map(c => ({ value: c.id, label: c.name }))} disabled={immutable} onCommit={value => update('calendarId', value)} />
      <label className="check"><input type="checkbox" checked={a.elapsedMode} disabled={immutable} onChange={e => update('elapsedMode', String(e.target.checked))} />Elapsed (24-hour) duration</label>
      {dateInput('Planned start', 'plannedStart')}{dateInput('Planned finish', 'plannedFinish')}
      {input('Constraint', 'constraintType', 'text', ['ASAP', 'START_NO_EARLIER_THAN', 'FINISH_NO_LATER_THAN', 'MUST_START_ON', 'MUST_FINISH_ON'])}
      {a.constraintType && a.constraintType !== 'ASAP' && dateInput('Constraint date', 'constraintDate')}
      {a.type === 'MILESTONE' && dateInput('Milestone target', 'targetDate')}
      <dl className="readouts"><dt>Calculated start</dt><dd>{fullDate(schedule?.calculatedStart)}</dd><dt>Calculated finish</dt><dd>{fullDate(schedule?.calculatedFinish)}</dd>
        <dt>Late start</dt><dd>{fullDate(schedule?.lateStart)}</dd><dt>Late finish</dt><dd>{fullDate(schedule?.lateFinish)}</dd><dt>Total slack</dt><dd className={(schedule?.totalSlack ?? 0) < 0 ? 'negative' : ''}>{num(schedule?.totalSlack)}d {schedule?.critical ? ' / CRITICAL' : ''}</dd></dl>
    </details>
    <details open><summary>Risk Exposure Score</summary>
      {input('Delay probability (0-1)', 'probabilityOfDelay', 'number')}{input('Delay P80 (working days)', 'delayP80', 'number')}
      {input('Manual intrinsic risk (0-100)', 'intrinsicRisk', 'number')}<small>Leave manual risk empty to use probability x delay/horizon.</small>
      <dl className="readouts"><dt>Intrinsic</dt><dd>{num(risk?.intrinsicRisk)}</dd><dt>Conflict floor</dt><dd>{num(risk?.conflictRisk)}</dd><dt>Propagated</dt><dd>{num(risk?.propagatedRisk)}</dd><dt>Total exposure</dt><dd><strong>{num(risk?.totalRisk)} / 100</strong></dd></dl>
      {risk?.contributors.map(c => <div className="contributor-card" key={c.dependencyId}><strong>{m.activities.find(a => a.id === c.predecessorId)?.name}</strong><b>+{num(c.transmittedRisk)}</b>
        <dl><dt>Predecessor risk / probability</dt><dd>{num(c.predecessorRisk)} / {num(c.probabilityOfDelay)}</dd>
          <dt>P80 / drift</dt><dd>{num(c.delayP80)}d / {num(c.currentDrift)}d</dd><dt>Edge slack / spill</dt><dd>{num(c.availableSlack)}d / {num(c.spill)}d</dd>
          <dt>Pressure / damping</dt><dd>{num(c.pressure)} / {num(c.damping)}</dd></dl></div>)}
      <small>Exposure is a deterministic indicator, not a calibrated probability. Contributions are non-additive.</small>
    </details>
    <details open><summary>Dependencies</summary>{m.dependencies.filter(d => d.predecessorId === a.id || d.successorId === a.id).map(d =>
      <button className="dependency-link" key={d.id} onClick={() => s.select([], d.id)}>
        {d.successorId === a.id ? '<- ' : '-> '}{m.activities.find(x => x.id === (d.successorId === a.id ? d.predecessorId : d.successorId))?.code} · {d.type} {d.lag > 0 ? '+' : ''}{d.lag}{d.lagUnit}
      </button>)}</details>
    <details><summary>Execution dates</summary>{dateInput('Actual start', 'actualStart')}{dateInput('Actual finish', 'actualFinish')}</details>
    {!!overrides.length && <details open><summary>Scenario overrides</summary>{overrides.map(o => <div className="override" key={o.id}><b>{o.fieldName}</b><span>{JSON.stringify(o.value)}</span></div>)}</details>}
    {!!schedule?.violations.length && <div className="violations">{schedule.violations.map((v, i) => <p key={i}>! {v.message} {num(v.deltaDays)} working days.</p>)}</div>}
  </aside>;
}
