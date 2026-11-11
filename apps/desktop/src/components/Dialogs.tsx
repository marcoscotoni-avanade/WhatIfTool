import { useEffect, useState } from 'react';
import { createProject, iso, type Dependency, type ProjectModel } from '@planner/domain';
import { importCsv, importJson, toCsv, exportJson } from '@planner/persistence';
import { isTauri, invoke } from '@tauri-apps/api/core';
import type { ProjectSummary } from '@planner/persistence';
import { useProjectStore } from '../store/useProjectStore';
import { toModel } from '../store/document';
import { download, repository } from '../persistence/local';
import { Field, Modal, useResolved } from './shared';

export function NameDialog({ kind, close }: { kind: 'new' | 'scenario' | 'clone' | 'rename' | 'baseline'; close: () => void }) {
  const s = useProjectStore(), [name, setName] = useState(kind === 'new' ? 'New Project' : kind === 'baseline' ? `Baseline v${s.document.baselines.length + 1}` : kind === 'rename' ? s.document.scenariosById[s.activeScenarioId ?? '']?.name ?? '' : 'What-if Scenario');
  const title = { new: 'New project', scenario: 'New scenario', clone: 'Clone scenario', rename: 'Rename scenario', baseline: 'Publish immutable baseline' }[kind];
  return <Modal title={title} close={close}><form onSubmit={e => {
    e.preventDefault();
    if (!name.trim()) return;
    if (kind === 'new') s.load(createProject(name.trim()));
    else if (kind === 'baseline') s.baseline(name.trim());
    else if (kind === 'rename') s.renameScenario(name.trim());
    else s.newScenario(name.trim(), kind === 'clone');
    close();
  }}><label className="field"><span>Name</span><input aria-label="Name" value={name} onChange={e => setName(e.target.value)} required /></label>
    {kind === 'baseline' && <p>This creates a new immutable version. Existing baselines and scenarios remain unchanged.</p>}
    <button className="primary" type="submit">{kind === 'baseline' ? 'Publish baseline' : 'Create / apply'}</button></form></Modal>;
}
export function GlobalSetupDialog({ close, autoSaveEnabled, onAutoSaveChange, tagCatalog, tagsDisabled, onTagCatalogChange }: {
  close: () => void; autoSaveEnabled: boolean; onAutoSaveChange: (enabled: boolean) => void;
  tagCatalog: string[]; tagsDisabled: boolean; onTagCatalogChange: (tags: string[]) => boolean;
}) {
  const [tags, setTags] = useState(tagCatalog), [newTag, setNewTag] = useState('');
  const normalizedTag = newTag.trim();
  const addTag = () => {
    if (!normalizedTag || normalizedTag.includes(',') || tags.some(tag => tag.toLocaleLowerCase() === normalizedTag.toLocaleLowerCase())) return;
    setTags(previous => [...previous, normalizedTag]);
    setNewTag('');
  };
  return <Modal title="Setup" close={close}>
    <label className="check"><input aria-label="Enable auto-save" type="checkbox" checked={autoSaveEnabled}
      onChange={event => onAutoSaveChange(event.target.checked)} />Auto-save every minute</label>
    <p>Automatic saves run only when there are unsaved changes. They do not show the green save confirmation.</p>
    <h3>Project tag catalog</h3>
    <p>Manage the tags available for task cards.</p>
    <div className="tag-catalog-add"><input aria-label="New tag" value={newTag} disabled={tagsDisabled}
      onChange={event => setNewTag(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addTag(); } }} />
      <button disabled={tagsDisabled || !normalizedTag || normalizedTag.includes(',') || tags.some(tag => tag.toLocaleLowerCase() === normalizedTag.toLocaleLowerCase())}
        onClick={addTag}>Add tag</button></div>
    <div className="tag-catalog">{tags.map(tag => <span className="tag-catalog-item" key={tag}>{tag}
      <button aria-label={`Remove tag ${tag}`} disabled={tagsDisabled} onClick={() => setTags(previous => previous.filter(value => value !== tag))}>×</button>
    </span>)}</div>
    {tagsDisabled && <p className="info-box">Published baseline is read-only. Create or select an editable scenario to manage its tag catalog.</p>}
    <button className="primary" disabled={tagsDisabled} onClick={() => { if (onTagCatalogChange(tags)) close(); }}>Apply tag catalog</button>
  </Modal>;
}
export function DependencyDialog({ close }: { close: () => void }) {
  const s = useProjectStore(), m = useResolved();
  const [predecessor, setPredecessor] = useState(s.selectedActivityIds[0] ?? m.activities[0]?.id ?? '');
  const [successor, setSuccessor] = useState(s.selectedActivityIds[1] ?? m.activities[1]?.id ?? '');
  const [type, setType] = useState<Dependency['type']>('FS'), [lag, setLag] = useState('0'), [unit, setUnit] = useState<Dependency['lagUnit']>('d');
  return <Modal title="Add dependency" close={close}><form onSubmit={e => {
    e.preventDefault(); s.connect(predecessor, successor, type, Number(lag), unit);
    if (!useProjectStore.getState().error) close();
  }}>
    <Field label="Predecessor" value={predecessor} options={m.activities.map(a => ({ value: a.id, label: `${a.code} - ${a.name}` }))} onCommit={setPredecessor} />
    <Field label="Successor" value={successor} options={m.activities.map(a => ({ value: a.id, label: `${a.code} - ${a.name}` }))} onCommit={setSuccessor} />
    <Field label="Type" value={type} options={['FS', 'SS', 'FF', 'SF']} onCommit={v => setType(v as Dependency['type'])} />
    <label className="field"><span>Lag (negative for lead)</span><input aria-label="Lag" type="number" step="any" value={lag} onChange={e => setLag(e.target.value)} required /></label>
    <Field label="Unit" value={unit} options={['d', 'h']} onCommit={v => setUnit(v as Dependency['lagUnit'])} />
    <button type="submit" className="primary">Connect</button>
  </form></Modal>;
}
export function RecentDialog({ close }: { close: () => void }) {
  const [items, setItems] = useState<ProjectSummary[]>(), s = useProjectStore();
  useEffect(() => { void repository.then(r => r.listProjects()).then(setItems).catch(s.report); }, [s.report]);
  return <Modal title="Recent local projects" close={close}>
    {items?.map(item => <button className="recent-item" key={item.id} onClick={() => {
      void repository.then(r => r.loadProject(item.id)).then(m => { s.load(m); close(); }).catch(s.report);
    }}><strong>{item.name}</strong><small>{new Date(item.modifiedAt).toLocaleString()}</small></button>)}
    {!items && <p>Loading local projects...</p>}{items?.length === 0 && <p>No saved projects yet. Save a project to add it here.</p>}
  </Modal>;
}
export function ProjectSettingsDialog({ close }: { close: () => void }) {
  const s = useProjectStore(), m = useResolved(), [calendarText, setCalendarText] = useState(JSON.stringify(m.calendars[0], null, 2));
  const immutable = !!s.activeScenarioId && !!s.document.scenariosById[s.activeScenarioId]?.isBaseline;
  const edit = (field: string, value: unknown) => s.updateEntity('project', m.project.id, { [field]: value });
  return <Modal title="Project & risk settings" close={close} wide>
    <div className="settings-columns"><div><h3>Project</h3>
      <Field label="Project name" value={m.project.name} disabled={immutable} onCommit={v => edit('name', v)} />
      <Field label="Project start (UTC)" type="datetime-local" value={m.project.projectStart.slice(0, 16)} disabled={immutable} onCommit={v => { try { edit('projectStart', iso(`${v}Z`)); } catch (e) { s.report(e); } }} />
      <Field label="Target finish (UTC)" type="datetime-local" value={m.project.targetFinish?.slice(0, 16)} disabled={immutable} onCommit={v => { try { edit('targetFinish', v ? iso(`${v}Z`) : undefined); } catch (e) { s.report(e); } }} />
      <h3>Risk settings</h3>{(['riskThreshold', 'defaultDamping', 'transmissionCap', 'defaultImpactHorizon'] as const).map(field =>
        <Field key={field} label={field} value={m.settings[field]} type="number" disabled={immutable} onCommit={v => s.updateEntity('settings', 'risk', { [field]: Number(v) })} />)}
      <Field label="Risk color thresholds (comma-separated)" value={m.settings.riskColorThresholds.join(',')} disabled={immutable}
        onCommit={v => s.updateEntity('settings', 'risk', { riskColorThresholds: v.split(',').map(Number) })} />
    </div><div><h3>Working calendar (UTC)</h3><p>Weekly days: Sunday=0. Intervals use HH:mm. Holidays use YYYY-MM-DD. Exceptions replace the entire day's intervals.</p>
      <textarea aria-label="Calendar JSON" rows={22} value={calendarText} onChange={e => setCalendarText(e.target.value)} disabled={immutable} />
      <button disabled={immutable} onClick={() => {
        try {
          const value: unknown = JSON.parse(calendarText);
          if (typeof value !== 'object' || value === null || Reflect.get(value, 'id') !== m.calendars[0]!.id) throw new Error('Calendar ID cannot change.');
          const { id: _id, ...patch } = value as Record<string, unknown>;
          s.updateEntity('calendar', m.calendars[0]!.id, patch);
          if (useProjectStore.getState().pendingEdit) close();
        } catch (error) { s.report(error); }
      }}>Apply validated calendar</button>
    </div></div>
  </Modal>;
}
export function ExchangeDialog({ close }: { close: () => void }) {
  const s = useProjectStore(), m = useResolved(), [kind, setKind] = useState('json');
  const [filename, setFilename] = useState(''), [bytes, setBytes] = useState<Uint8Array>();
  const nativeExport = async (name: string, text: string) => {
    if (!isTauri()) { download(name, text, name.endsWith('.csv') ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8'); return; }
    const { save } = await import('@tauri-apps/plugin-dialog');
    const path = await save({ defaultPath: name });
    if (path) await invoke('write_project', { path, bytes: Array.from(new TextEncoder().encode(text)) });
  };
  const exportFile = async () => {
    const model = toModel(s.document);
    if (kind === 'json') await nativeExport(`${m.project.name}.json`, exportJson(model));
    else if (kind === 'activities') await nativeExport('activities.csv', toCsv(m.activities));
    else if (kind === 'dependencies') await nativeExport('dependencies.csv', toCsv(m.dependencies));
    else {
      const results = s.results;
      if (!results || s.calculationStatus !== 'ready') throw new Error('Wait for a successful calculation before exporting results.');
      await nativeExport('scenario-results.csv', toCsv(m.activities.map(a => ({ id: a.id, code: a.code, name: a.name, scenario: s.activeScenarioId ?? 'draft',
        ...results.schedule.activities[a.id], ...results.risk[a.id], schedulingEngineVersion: results.schedule.engineVersion, riskEngineVersion: results.riskEngineVersion }))));
    }
  };
  const importFile = async () => {
    if (!bytes) throw new Error('Select a file first.');
    let imported: ProjectModel;
    if (filename.endsWith('.pgplan')) imported = (await repository).decode(bytes);
    else if (kind === 'json') imported = importJson(new TextDecoder().decode(bytes));
    else if (kind === 'activities' || kind === 'dependencies') {
      if (s.activeScenarioId) throw new Error('CSV replacement import is only available in the working draft.');
      imported = importCsv(toModel(s.document), new TextDecoder().decode(bytes), kind);
      if (s.commit('Import CSV', () => imported)) close();
      return;
    } else throw new Error('Calculated results cannot be imported as planning inputs.');
    s.load(imported); useProjectStore.setState({ dirty: true }); close();
  };
  return <Modal title="Import / Export" close={close}>
    <Field label="Data format" value={kind} options={[{ value: 'json', label: 'JSON - complete project' }, { value: 'activities', label: 'CSV - activities' },
      { value: 'dependencies', label: 'CSV - dependencies' }, { value: 'results', label: 'CSV - scenario results (export only)' }]} onCommit={setKind} />
    <p>JSON includes baseline history, scenario overrides and settings. CSV imports replace the selected draft collection after validation; IDs must match dependency endpoints. CSV durations are imported as provided and are not recalculated automatically.</p>
    <button className="primary" onClick={() => void exportFile().catch(s.report)}>Export selected format</button><hr />
    <label className="field"><span>Import file (.json, .csv or .pgplan)</span><input aria-label="Import file" type="file" accept=".json,.csv,.pgplan" onChange={e => {
      const file = e.target.files?.[0]; if (!file) return;
      setFilename(file.name.toLowerCase()); void file.arrayBuffer().then(b => setBytes(new Uint8Array(b))).catch(s.report);
    }} /></label>
    <button disabled={!bytes} onClick={() => void importFile().catch(s.report)}>Validate & import</button>
  </Modal>;
}
