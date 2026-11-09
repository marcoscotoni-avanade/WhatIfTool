import { useState } from 'react';
import type { Team } from '@planner/domain';
import { useProjectStore } from '../store/useProjectStore';
import { Field, Modal, useResolved } from './shared';

export function TeamDialog({ close }: { close: () => void }) {
  const m = useResolved(), s = useProjectStore();
  const [team, setTeam] = useState<Team>(() => structuredClone(m.project.team ?? { name: 'Project team', calendarId: m.project.defaultCalendarId, members: [] }));
  const updateMember = (id: string, patch: Partial<Team['members'][number]>) =>
    setTeam(t => ({ ...t, members: t.members.map(member => member.id === id ? { ...member, ...patch } : member) }));
  return <Modal title="Project team" close={close} wide>
    <p>Allocation is the percentage of each working day available to an activity. Concurrent activities are not resource-levelled.</p>
    <Field label="Team name" value={team.name} onCommit={name => setTeam(t => ({ ...t, name }))} />
    <Field label="Team calendar" value={team.calendarId} options={m.calendars.map(c => ({ value: c.id, label: c.name }))}
      onCommit={calendarId => setTeam(t => ({ ...t, calendarId }))} />
    <h3>People</h3>
    {team.members.map(member => <div className="team-member" key={member.id}>
      <Field label={`Name (${member.id.slice(0, 8)})`} value={member.name} onCommit={name => updateMember(member.id, { name })} />
      <Field label={`Allocation % (${member.id.slice(0, 8)})`} type="number" min={0} max={100} value={member.allocationPercent}
        onCommit={value => updateMember(member.id, { allocationPercent: Number(value) })} />
      <button aria-label={`Remove ${member.name}`} onClick={() => setTeam(t => ({ ...t, members: t.members.filter(x => x.id !== member.id) }))}>Remove</button>
    </div>)}
    <button onClick={() => setTeam(t => ({ ...t, members: [...t.members, { id: crypto.randomUUID(), name: 'New person', allocationPercent: 100 }] }))}>Add person</button>
    <div className="dialog-actions"><button className="primary" onClick={() => {
      s.updateEntity('project', m.project.id, { team });
      if (!useProjectStore.getState().error) close();
    }}>Apply team</button><button onClick={close}>Cancel</button></div>
  </Modal>;
}

export function DurationProposalDialog() {
  const pending = useProjectStore(s => s.pendingEdit), finish = useProjectStore(s => s.finishEdit);
  const [selected, setSelected] = useState(() => new Set(pending?.proposals.filter(p => p.duration !== undefined).map(p => p.activityId)));
  if (!pending) return null;
  return <Modal title="Recalculate duration?" close={() => finish()} wide>
    <p>Select activities to recalculate. Unselected activities keep their duration and working calendar. The original edit will still be saved.</p>
    {pending.proposals.map(p => <div key={p.activityId}>
      <label className="check"><input type="checkbox" disabled={p.duration === undefined} checked={selected.has(p.activityId)}
        onChange={e => setSelected(previous => { const next = new Set(previous); if (e.target.checked) next.add(p.activityId); else next.delete(p.activityId); return next; })} />
        <strong>{p.code}</strong> — {p.previousDuration} {p.durationUnit} → {p.duration === undefined ? p.reason : `${Number(p.duration.toPrecision(12))} ${p.durationUnit} · ${p.allocationPercent}% · ${p.calendarName}`}
      </label>
    </div>)}
    <div className="dialog-actions"><button className="primary" onClick={() => finish([...selected])}>Apply selected</button>
      <button onClick={() => finish([])}>Keep durations</button><button onClick={() => finish()}>Cancel entire edit</button></div>
  </Modal>;
}
