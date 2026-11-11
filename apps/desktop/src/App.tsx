import { useCallback, useEffect, useRef, useState } from 'react';
import { createDemo, type ProjectModel } from '@planner/domain';
import { isTauri } from '@tauri-apps/api/core';
import { connection, persistAction, useProjectStore } from './store/useProjectStore';
import { useStore } from 'zustand';
import { ConnectionPanel, ConnectionStatus } from './components/ConnectionPanel';
import { requestCalculation } from './workers/client';
import { PlanningGraph } from './graph/PlanningGraph';
import { ActivityGrid } from './grid/ActivityGrid';
import { PropertyPanel } from './properties/PropertyPanel';
import { Explorer } from './components/Explorer';
import { Comparison } from './scenarios/Comparison';
import { DependencyDialog, ExchangeDialog, GlobalSetupDialog, NameDialog, ProjectSettingsDialog, RecentDialog } from './components/Dialogs';
import { Modal, displayDate, num, useResolved } from './components/shared';
import { DurationProposalDialog, TeamDialog } from './components/TeamDialogs';
import { openNativeProject, repository, saveProject } from './persistence/local';
import './styles/app.css';
import { BaselineManager } from './components/BaselineManager';

type Dialog = 'globalSetup' | 'new' | 'scenario' | 'clone' | 'rename' | 'baseline' | 'baselines' | 'dependency' | 'exchange' | 'settings' | 'recent' | 'compare' | 'team';
const AUTO_SAVE_KEY = 'project-risk-planner.auto-save';
export default function App() {
  const s = useProjectStore(), m = useResolved(), [dialog, setDialog] = useState<Dialog>(), [welcome, setWelcome] = useState(true);
  const connectionState = useStore(connection.state);
  const [pendingAction, setPendingAction] = useState<(() => void) | undefined>(), [saving, setSaving] = useState(false);
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(false), [autoSavePulse, setAutoSavePulse] = useState(0);
  const savingRef = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null), [graphPercent, setGraphPercent] = useState(61), workspace = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setDialog(undefined), []);
  const immutable = !!s.activeScenarioId && !!s.document.scenariosById[s.activeScenarioId]?.isBaseline;
  const guard = useCallback((action: () => void) => {
    if (useProjectStore.getState().dirty) setPendingAction(() => action); else action();
  }, []);
  const save = useCallback(async (saveAs = false, automatic = false): Promise<boolean> => {
    if (savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    try { return await saveProject(saveAs, { automatic, notify: !automatic }); }
    catch (error) { useProjectStore.getState().report(error); return false; }
    finally { savingRef.current = false; setSaving(false); }
  }, []);
  const updateAutoSave = useCallback((enabled: boolean) => {
    try {
      localStorage.setItem(AUTO_SAVE_KEY, String(enabled));
      setAutoSaveEnabled(enabled);
    } catch (error) { useProjectStore.getState().report(error); }
  }, []);
  useEffect(() => {
    try { setAutoSaveEnabled(localStorage.getItem(AUTO_SAVE_KEY) === 'true'); }
    catch (error) { useProjectStore.getState().report(error); }
  }, []);
  useEffect(() => {
    if (!autoSaveEnabled) return;
    const timer = window.setInterval(() => {
      if (!useProjectStore.getState().dirty || savingRef.current) return;
      void save(false, true).then(saved => { if (saved) setAutoSavePulse(pulse => pulse + 1); });
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [autoSaveEnabled, save]);
  const open = useCallback(() => guard(() => {
    if (isTauri()) void openNativeProject().catch(useProjectStore.getState().report); else fileInput.current?.click();
  }), [guard]);
  useEffect(() => { const timer = setTimeout(() => requestCalculation(), 90); return () => clearTimeout(timer); }, [s.document, s.activeScenarioId, s.activeMilestoneId, s.revision]);
  useEffect(() => {
    const keyboard = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (e.ctrlKey || e.metaKey) {
        if (e.key.toLowerCase() === 's') { e.preventDefault(); void save(e.shiftKey); }
        if (e.key.toLowerCase() === 'o') { e.preventDefault(); open(); }
        if (e.key.toLowerCase() === 'z' && !['INPUT', 'TEXTAREA'].includes(tag)) { e.preventDefault(); if (e.shiftKey) useProjectStore.getState().redo(); else useProjectStore.getState().undo(); }
        if (e.key.toLowerCase() === 'y' && !['INPUT', 'TEXTAREA'].includes(tag)) { e.preventDefault(); useProjectStore.getState().redo(); }
      }
    };
    const beforeUnload = (e: BeforeUnloadEvent) => { if (useProjectStore.getState().dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('keydown', keyboard); window.addEventListener('beforeunload', beforeUnload);
    return () => { window.removeEventListener('keydown', keyboard); window.removeEventListener('beforeunload', beforeUnload); };
  }, [save, open]);
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined, disposed = false;
    void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      const window = getCurrentWindow();
      const stop = await window.onCloseRequested(event => {
        if (useProjectStore.getState().dirty) {
          event.preventDefault();
          setPendingAction(() => () => { void window.destroy().catch(useProjectStore.getState().report); });
        }
      });
      if (disposed) stop(); else unlisten = stop;
    }).catch(useProjectStore.getState().report);
    return () => { disposed = true; unlisten?.(); };
  }, []);
  useEffect(() => {
    if (!s.notice) return;
    const timer = setTimeout(() => useProjectStore.setState({ notice: undefined }), 4000);
    return () => clearTimeout(timer);
  }, [s.notice]);
  const focus = () => {
    if (s.activeMilestoneId) { useProjectStore.setState({ activeMilestoneId: undefined }); return; }
    const a = m.activities.find(a => s.selectedActivityIds.includes(a.id) && a.type === 'MILESTONE');
    if (!a) { s.report('Select a milestone to activate Milestone Focus.'); return; }
    useProjectStore.setState({ activeMilestoneId: a.id });
  };
  const loadFile = async (file?: File) => {
    if (!file) return;
    const repo = await repository, model: ProjectModel = repo.decode(new Uint8Array(await file.arrayBuffer()));
    if (!connection.connected()) await repo.saveProject(model);
    await persistAction(() => s.load(model));
  };
  const resizeStart = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => {
      const rect = workspace.current?.getBoundingClientRect();
      if (rect) setGraphPercent(Math.min(82, Math.max(25, (e.clientY - rect.top) / rect.height * 100)));
    };
    const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop);
  };
  const violations = Object.values(s.results?.schedule.activities ?? {}).flatMap(a => a.violations);
  return <main className="app-shell">
    <header className="app-header"><div className="brand"><span className="brand-mark">P<span>R</span></span><div><b>PROJECT RISK PLANNER</b><small>Schedule digital twin</small></div></div>
      <div className="project-heading"><strong>{m.project.name}{s.dirty ? ' *' : ''}</strong><span>{s.activeScenarioId ? s.document.scenariosById[s.activeScenarioId]?.name : 'Working draft'}</span></div>
      <div className="file-actions"><ConnectionPanel /><button onClick={() => setDialog('globalSetup')}>Setup</button><button onClick={() => guard(() => setDialog('new'))}>New</button><button onClick={open}>Open</button>
        <button onClick={() => guard(() => setDialog('exchange'))}>Import / Export</button><button disabled={saving} onClick={() => void save(true)}>Save As</button>
        <button className="primary" disabled={saving} onClick={() => void save()}>{saving ? 'Saving...' : 'Save'}</button>
        {autoSavePulse > 0 && <span key={autoSavePulse} className="auto-save-indicator" role="img" aria-label="Auto-save completed" title="Auto-save completed">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 1h10l3 3v11H1V1h1zm2 1v4h7V2H4zm0 7v5h8V9H4zm1 1h6v3H5v-3z" /></svg>
        </span>}</div></header>
    <ConnectionStatus />
    <nav className="toolbar" aria-label="Planning toolbar" inert={connectionState.mode === 'connected' && (connectionState.busy || !!connectionState.error)}>
      <div><button disabled={immutable} onClick={() => s.addActivity()}>+ Activity</button><button disabled={immutable} onClick={() => s.addActivity(true)}>+ Milestone</button>
        <button disabled={immutable || m.activities.length < 2} onClick={() => setDialog('dependency')}>Add Dependency</button>
        <button disabled={immutable} onClick={() => setDialog('team')}>Team</button><button disabled={immutable || !s.selectedActivityIds.length} onClick={s.duplicateSelection}>Duplicate</button>
        <button disabled={immutable || (!s.selectedActivityIds.length && !s.selectedDependencyId)} onClick={s.deleteSelection}>Delete</button></div>
      <div><button disabled={!s.history.length} title="Ctrl+Z" onClick={s.undo}>Undo</button><button disabled={!s.future.length} title="Ctrl+Y" onClick={s.redo}>Redo</button></div>
      <div className="scenario-tools"><select aria-label="Active scenario" value={s.activeScenarioId ?? ''} onChange={e => s.activateScenario(e.target.value || undefined)}>
        <option value="">Working draft</option>{Object.values(s.document.scenariosById).filter(x => !x.isBaseline || x.id === s.activeScenarioId || !s.document.baselines.find(b => b.id === x.baselineVersionId)?.archived).map(x => <option key={x.id} value={x.id}>{x.isBaseline ? '[B] ' : ''}{x.name}</option>)}</select>
        <button onClick={() => setDialog('scenario')}>New Scenario</button><button disabled={!s.activeScenarioId} onClick={() => setDialog('clone')}>Clone</button>
        <button onClick={() => setDialog('baseline')}>{s.activeScenarioId && !immutable ? 'Promote' : 'Publish Baseline'}</button>
        <button onClick={() => setDialog('baselines')}>Manage Baselines</button>
        <button disabled={!s.activeScenarioId} onClick={() => { useProjectStore.setState({ comparison: undefined }); setDialog('compare'); requestCalculation(true); }}>Compare</button>
        <button disabled={!s.activeScenarioId || immutable} onClick={() => setDialog('rename')}>Rename</button>
        <button disabled={!s.activeScenarioId || immutable} onClick={s.removeScenario}>Delete Scenario</button></div>
      <div><button className={s.riskFlow ? 'active-toggle' : ''} aria-pressed={s.riskFlow} onClick={() => useProjectStore.setState({ riskFlow: !s.riskFlow })}>Risk Flow</button>
        <button className={s.activeMilestoneId ? 'active-toggle' : ''} aria-pressed={!!s.activeMilestoneId} onClick={focus}>Milestone Focus</button>
        <select aria-label="View mode" value={s.viewMode} onChange={e => useProjectStore.setState({ viewMode: e.target.value as typeof s.viewMode })}>
          <option value="split">Split view</option><option value="graph">Graph only</option><option value="grid">Grid only</option></select></div>
    </nav>
    {s.error && <div role="alert" className="error-banner"><strong>! {s.error}</strong><button onClick={() => useProjectStore.setState({ error: undefined })}>Dismiss</button></div>}
    {s.notice && <div role="status" className="notice-banner">{s.notice}</div>}
    <div className="summary-bar"><span><small>PROJECT FINISH</small><b>{displayDate(s.results?.schedule.projectFinish)}</b></span>
      <span><small>CRITICAL ACTIVITIES</small><b>{Object.values(s.results?.schedule.activities ?? {}).filter(a => a.critical).length}</b></span>
      <span><small>NEGATIVE SLACK</small><b className={Object.values(s.results?.schedule.activities ?? {}).some(a => a.totalSlack < 0) ? 'negative' : ''}>{num(Math.min(0, ...Object.values(s.results?.schedule.activities ?? {}).map(a => a.totalSlack)))}d</b></span>
      <span><small>MAX EXPOSURE</small><b>{num(Math.max(0, ...Object.values(s.results?.risk ?? {}).map(a => a.totalRisk)))}</b></span>
      <span><small>SCHEDULE CONFLICTS</small><b className={violations.length ? 'negative' : ''}>{violations.length}</b></span>
      <p>Change an activity.<br /><strong>See what happens. Understand why.</strong></p></div>
    <div className="workspace" ref={workspace} inert={connectionState.mode === 'connected' && (connectionState.busy || !!connectionState.error)} style={{ gridTemplateRows: s.viewMode === 'split' ? `minmax(150px, ${graphPercent}fr) 8px minmax(130px, ${100 - graphPercent}fr)` : 'minmax(0, 1fr)' }}>
      <div className="upper-workspace" style={{ display: s.viewMode === 'grid' ? 'none' : undefined }}>
        <Explorer openRecent={() => guard(() => setDialog('recent'))} projectSettings={() => setDialog('settings')} />
        <PlanningGraph /><PropertyPanel />
      </div>
      {s.viewMode === 'split' && <div role="separator" aria-label="Resize graph and grid" aria-orientation="horizontal" tabIndex={0} className="splitter" onPointerDown={resizeStart}
        onKeyDown={e => { if (e.key === 'ArrowUp') setGraphPercent(p => Math.max(25, p - 5)); if (e.key === 'ArrowDown') setGraphPercent(p => Math.min(82, p + 5)); }} />}
      {s.viewMode !== 'graph' && <ActivityGrid />}
    </div>
    <footer className="status-bar"><span className={`status-dot ${s.calculationStatus}`} />{s.calculationStatus === 'calculating' ? 'Recalculating in worker...' : s.calculationStatus === 'error' ? 'Calculation failed' : 'Local engines ready'}
      <span>{s.results ? `Scheduler ${s.results.schedule.engineVersion} · Risk ${s.results.riskEngineVersion}` : ''}</span>
      <span>{s.results?.schedule.recalculatedIds.length ?? 0} forward dates recalculated</span><span>{s.path ?? 'Local SQLite workspace'}</span><span>{s.dirty ? 'Unsaved changes' : 'Saved / unchanged'}</span></footer>
    <input ref={fileInput} className="hidden-input" type="file" aria-label="Open project file" accept=".pgplan" onChange={e => { void loadFile(e.target.files?.[0]).catch(s.report); e.target.value = ''; }} />
    {welcome && <Modal title="Your project. A living model." close={() => setWelcome(false)}>
      <p>Explore dependencies, simulate delays and trace risk to the milestones that matter. Everything stays on this device.</p>
      <div className="welcome-features"><span>01 · Edit the schedule</span><span>02 · Follow the risk</span><span>03 · Protect your milestone</span></div>
      <button className="primary large" onClick={() => { void persistAction(() => s.load(createDemo())).then(ok => { if (ok) { if (!connection.connected()) useProjectStore.setState({ dirty: true }); useProjectStore.setState({ riskFlow: true }); setWelcome(false); } }); }}>Open Demo Project</button>
      <div className="welcome-actions"><button onClick={() => { setWelcome(false); setDialog('new'); }}>Create New Project</button><button onClick={() => { setWelcome(false); setDialog('recent'); }}>Recent Projects</button><button onClick={() => { setWelcome(false); open(); }}>Open Project</button></div>
    </Modal>}
    {dialog === 'baselines' && <BaselineManager close={close} />}
    {dialog && ['new', 'scenario', 'clone', 'rename', 'baseline'].includes(dialog) && <NameDialog kind={dialog as 'new' | 'scenario' | 'clone' | 'rename' | 'baseline'} close={close} />}
    {dialog === 'globalSetup' && <GlobalSetupDialog close={close} autoSaveEnabled={autoSaveEnabled} onAutoSaveChange={updateAutoSave}
      tagCatalog={m.project.tagCatalog ?? []} tagsDisabled={immutable} onTagCatalogChange={s.setTagCatalog} />}
    {dialog === 'dependency' && <DependencyDialog close={close} />}{dialog === 'settings' && <ProjectSettingsDialog close={close} />}
    {dialog === 'recent' && <RecentDialog close={close} />}{dialog === 'exchange' && <ExchangeDialog close={close} />}
    {dialog === 'compare' && <Comparison close={close} />}
    {dialog === 'team' && <TeamDialog close={close} />}
    {s.pendingEdit && <DurationProposalDialog />}
    {pendingAction && <Modal title="Unsaved changes" close={() => setPendingAction(undefined)}>
      <p>Save your changes before leaving this project?</p><div className="dialog-actions">
        <button className="primary" onClick={() => {
          void save().then(() => { if (!useProjectStore.getState().dirty) { const action = pendingAction; setPendingAction(undefined); action(); } });
        }}>Save & continue</button><button className="danger" onClick={() => { const action = pendingAction; setPendingAction(undefined); action(); }}>Discard & continue</button>
        <button onClick={() => setPendingAction(undefined)}>Cancel</button></div>
    </Modal>}
  </main>;
}
