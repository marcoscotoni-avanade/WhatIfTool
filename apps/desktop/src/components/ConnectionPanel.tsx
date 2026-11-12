import { useState } from 'react';
import { useStore } from 'zustand';
import { connection, useProjectStore } from '../store/useProjectStore';
import { Modal } from './shared';
import type { Approval, ImportApproval } from '../store/connection';

export function ConnectionPanel() {
  const c = useStore(connection.state), [open, setOpen] = useState(false);
  const [url, setUrl] = useState(c.url), [token, setToken] = useState('');
  const [projects, setProjects] = useState<{ id: string; name: string; revision: number }[]>([]);
  const [imports, setImports] = useState<ImportApproval[]>([]);
  const [error, setError] = useState<string>();
  const attempt = async (action: () => unknown) => {
    try { setError(undefined); await action(); } catch (e) { setError(String(e)); }
  };
  return <>
    <button onClick={() => setOpen(true)}>{c.mode === 'connected' ? `Connected · r${c.revision}` : 'Connect service'}</button>
    {open && <Modal title="Local planning service" close={() => setOpen(false)}>
      {c.mode === 'standalone' ? <form onSubmit={e => {
        e.preventDefault();
        void attempt(async () => { if (await connection.connect(url, token)) { setToken(''); setOpen(false); } });
      }}>
        <p>Opt in to shared, authoritative project state. An existing server project with this ID replaces the displayed local copy. Save a local copy first if needed.</p>
        <label className="field"><span>Service URL</span><input aria-label="Service URL" value={url} onChange={e => setUrl(e.target.value)} /></label>
        <label className="field"><span>UI token</span><input aria-label="UI token" type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} /></label>
        <button className="primary" disabled={c.busy} type="submit">Connect current project</button>
      </form> : <>
        <p>Connected to {c.url}. Changes are saved through the service. Polling every two seconds.</p>
        <button disabled={c.busy} onClick={() => void attempt(() => connection.refresh())}>Refresh / recover</button>
        <button disabled={c.busy} onClick={() => void attempt(() => { connection.disconnect(); setProjects([]); setImports([]); })}>Disconnect to local copy</button>
        <button disabled={c.busy} onClick={() => void attempt(async () => setProjects(await connection.listProjects()))}>List service projects</button>
        <button disabled={c.busy} onClick={() => void attempt(async () => setImports(await connection.listImports()))}>List import requests</button>
        {imports.map(item => <section key={item.id} aria-label={`Import ${item.name}`}>
          <strong>Agent requests import: {item.name}</strong>
          <p>Project ID: {item.projectId} · status: {item.status} · expires {item.expiresAt}</p>
          {item.reason && <p role="alert">Import failed: {item.reason}</p>}
          <p>{item.counts.activities} activities · {item.counts.dependencies} dependencies · {item.counts.scenarios} scenarios · {item.counts.baselines} baselines · {item.counts.calendars} calendars</p>
          <p>SHA-256: {item.hash}</p>
          {item.status === 'pending' && <><button disabled={c.busy} onClick={() => void attempt(async () => {
            await connection.decideImport(item.id, true); setImports(await connection.listImports());
          })}>Approve import</button>
          <button disabled={c.busy} onClick={() => void attempt(async () => {
            await connection.decideImport(item.id, false); setImports(await connection.listImports());
          })}>Reject import</button></>}
        </section>)}
        {projects.map(project => <button key={project.id} className="recent-item" disabled={c.busy} onClick={() => {
          void attempt(async () => { if (await connection.openProject(project.id)) setOpen(false); });
        }}>{project.name} · r{project.revision}</button>)}
      </>}
      {(error || c.error) && <p role="alert">{error ?? c.error}</p>}
    </Modal>}
  </>;
}

export function ConnectionStatus() {
  const c = useStore(connection.state);
  const pendingEdit = useProjectStore(s => s.pendingEdit);
  const [selectedId, setSelectedId] = useState<string>();
  if (c.mode !== 'connected') return null;
  const pending = c.approvals.filter(operation => operation.status === 'pending');
  const selected = pending.find(operation => operation.id === selectedId);
  return <><section aria-label="Service status" className={c.error ? 'error-banner' : 'notice-banner'}>
    <span>{c.error ?? (c.busy ? 'Waiting for authoritative service response…' : `Connected · revision ${c.revision} · live polling`)}</span>
    {c.error && <button disabled={c.busy} onClick={() => void connection.refresh()}>Refresh / recover</button>}
    {pending.length > 0 && <button onClick={() => setSelectedId(pending[0]!.id)}>
      Review agent requests ({pending.length})
    </button>}
  </section>
  {selected && <Modal title="Review agent request" close={() => setSelectedId(undefined)} wide className="approval-modal">
    <div className="approval-content">
      {pending.length > 1 && <label className="field"><span>Pending request</span>
        <select aria-label="Pending request" value={selected.id} onChange={e => setSelectedId(e.target.value)}>
          {pending.map((operation, index) => <option key={operation.id} value={operation.id}>
            {index + 1}. {operation.action} · {operation.scenarioId ?? 'working draft'} · {operation.id}
          </option>)}
        </select>
      </label>}
      <p><strong>Agent requests {selected.action}</strong> · {selected.scenarioId ?? 'working draft'} · expected r{selected.expectedRevision} · expires {selected.expiresAt}</p>
      <h3>Proposed changes ({selected.diff?.length ?? 0})</h3>
      {selected.diff?.length ? <div aria-label="Proposed changes">{selected.diff.map((change, index) =>
        <details key={`${selected.id}-${change.target}-${change.id}-${index}`}>
          <summary>{describeChange(change)}</summary>
          <strong>Before</strong><pre>{JSON.stringify(change.before, null, 2) ?? '(not present)'}</pre>
          <strong>After</strong><pre>{JSON.stringify(change.after, null, 2) ?? '(not present)'}</pre>
        </details>)}</div> : <p>No change details available.</p>}
      <details>
        <summary>Request arguments</summary>
        <pre>{JSON.stringify(selected.args, null, 2)}</pre>
      </details>
      {c.error && <p role="alert">{c.error}</p>}
      {pendingEdit && <p>Complete the pending duration proposal before approving this request.</p>}
    </div>
    <div className="dialog-actions approval-actions">
      <button className="primary" disabled={c.busy || !!c.error || !!pendingEdit} onClick={() => {
        void connection.decide(selected.id, true).then(ok => { if (ok) setSelectedId(undefined); });
      }}>Approve</button>
      <button disabled={c.busy || !!c.error} onClick={() => {
        void connection.decide(selected.id, false).then(ok => { if (ok) setSelectedId(undefined); });
      }}>Reject</button>
      <button onClick={() => setSelectedId(undefined)}>Close</button>
    </div>
  </Modal>}</>;
}

function describeChange(change: NonNullable<Approval['diff']>[number]) {
  const value = change.after ?? change.before;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const label = [record.code, record.name].filter(part => typeof part === 'string' && part).join(' · ');
    if (label) return `${change.target} · ${label} · ${change.id}`;
    if (typeof record.predecessorId === 'string' && typeof record.successorId === 'string')
      return `${change.target} · ${record.predecessorId} → ${record.successorId} · ${change.id}`;
  }
  return `${change.target} · ${change.id}`;
}
