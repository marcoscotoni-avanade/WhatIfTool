import { useState } from 'react';
import { useStore } from 'zustand';
import { connection, useProjectStore } from '../store/useProjectStore';
import { Modal } from './shared';
import type { ImportApproval } from '../store/connection';

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
  if (c.mode !== 'connected') return null;
  return <section aria-label="Service status" className={c.error ? 'error-banner' : 'notice-banner'}>
    <span>{c.error ?? (c.busy ? 'Waiting for authoritative service response…' : `Connected · revision ${c.revision} · live polling`)}</span>
    {c.error && <button disabled={c.busy} onClick={() => void connection.refresh()}>Refresh / recover</button>}
    {c.approvals.filter(operation => operation.status === 'pending').map(operation => <div key={operation.id}>
      <strong>Agent requests {operation.action}</strong> · {operation.scenarioId ?? 'working draft'} · expected r{operation.expectedRevision} · expires {operation.expiresAt}
      {operation.diff?.length ? <div aria-label="Proposed changes">{operation.diff.map((change, index) => <details key={`${change.target}-${change.id}-${index}`} open>
        <summary>{change.target} · {change.id}</summary>
        <strong>Before</strong><pre style={{ maxHeight: 140, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{JSON.stringify(change.before, null, 2) ?? '(not present)'}</pre>
        <strong>After</strong><pre style={{ maxHeight: 140, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{JSON.stringify(change.after, null, 2) ?? '(not present)'}</pre>
      </details>)}</div> : null}
      <pre style={{ maxHeight: 140, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{JSON.stringify(operation.args, null, 2)}</pre>
      <button disabled={c.busy || !!c.error || !!useProjectStore.getState().pendingEdit} onClick={() => void connection.decide(operation.id, true)}>Approve</button>
      <button disabled={c.busy || !!c.error} onClick={() => void connection.decide(operation.id, false)}>Reject</button>
    </div>)}
  </section>;
}
