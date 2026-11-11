import { useState } from 'react';
import { persistAction, useProjectStore } from '../store/useProjectStore';
import { Modal } from './shared';

export function BaselineManager({ close }: { close: () => void }) {
  const s = useProjectStore();
  const [selected, setSelected] = useState<string>();
  const [action, setAction] = useState<'delete' | 'archive' | 'restore'>('archive');
  const [name, setName] = useState('');
  const baseline = s.document.baselines.find(b => b.id === selected);
  return <Modal title="Manage baselines" close={close}>
    <p>Snapshots cannot be edited. Delete unused baselines, or archive them without breaking scenarios.</p>
    {s.document.baselines.map(b => {
      const users = Object.values(s.document.scenariosById).filter(x => !x.isBaseline && x.baselineVersionId === b.id);
      return <div key={b.id}><strong>{b.name}</strong> · {b.archived ? 'archived' : 'published'} · {users.length} scenarios
        <button onClick={() => { setSelected(b.id); setAction(b.archived ? 'restore' : 'archive'); setName(''); }}>{b.archived ? 'Restore' : 'Archive'}</button>
        <button disabled={users.length > 0} title={users.length ? 'Used by scenarios: archive instead' : 'Delete unused baseline'}
          onClick={() => { setSelected(b.id); setAction('delete'); setName(''); }}>Delete baseline</button>
      </div>;
    })}
    {baseline && <form onSubmit={event => {
      event.preventDefault();
      void persistAction(() => s.manageBaseline(baseline.id, action, name)).then(ok => { if (ok) { setSelected(undefined); setName(''); } });
    }}>
      <p>{action} baseline <strong>{baseline.name}</strong>? {action === 'delete' ? 'This removes the stored snapshot.' : 'Existing scenarios keep their reference.'}</p>
      <label className="field"><span>Type baseline name to confirm</span><input aria-label="Confirm baseline name" value={name} onChange={event => setName(event.target.value)} /></label>
      <button className="primary" disabled={name !== baseline.name}>Confirm {action}</button>
    </form>}
  </Modal>;
}
