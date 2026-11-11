import { useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef, type GridApi } from 'ag-grid-community';
import type { Activity } from '@planner/domain';
import { parseCsv } from '@planner/persistence';
import { persistAction, useProjectStore } from '../store/useProjectStore';
import { activityPatch } from '../store/editing';
import { Modal, fullDate, num, useResolved } from '../components/shared';
import { download } from '../persistence/local';
import { activityTemplate } from './activityTemplate';

ModuleRegistry.registerModules([AllCommunityModule]);
type Row = Activity & { calculatedStart?: string; calculatedFinish?: string; totalSlack?: number; risk?: number; predecessors: string; tagsText: string };
const theme = themeQuartz.withParams({ fontSize: 12, headerHeight: 34, rowHeight: 32, accentColor: '#217f93', borderColor: '#dce4eb', backgroundColor: '#ffffff', foregroundColor: '#243c4f' });
export function ActivityGrid() {
  const s = useProjectStore(), m = useResolved(), api = useRef<GridApi<Row> | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false), [paste, setPaste] = useState('');
  const [bulkField, setBulkField] = useState('duration'), [bulkValue, setBulkValue] = useState('');
  const immutable = !!s.activeScenarioId && !!s.document.scenariosById[s.activeScenarioId]?.isBaseline;
  const rows: Row[] = useMemo(() => m.activities.map(a => ({
    ...a, calculatedStart: s.results?.schedule.activities[a.id]?.calculatedStart, calculatedFinish: s.results?.schedule.activities[a.id]?.calculatedFinish,
    totalSlack: s.results?.schedule.activities[a.id]?.totalSlack, risk: s.results?.risk[a.id]?.totalRisk,
    predecessors: m.dependencies.filter(d => d.successorId === a.id).map(d => `${m.activities.find(p => p.id === d.predecessorId)?.code} ${d.type}${d.lag ? `${d.lag > 0 ? '+' : ''}${d.lag}${d.lagUnit}` : ''}`).join(', '),
    tagsText: a.type === 'TASK' ? (a.tags ?? []).join(', ') : '',
  })), [m, s.results]);
  const columns = useMemo<ColDef<Row>[]>(() => [
    { field: 'code', width: 105, pinned: 'left' }, { field: 'name', headerName: 'Activity', width: 205, pinned: 'left' },
    { field: 'type', width: 115, cellEditor: 'agSelectCellEditor', cellEditorParams: { values: ['TASK', 'MILESTONE', 'SUMMARY'] } },
    { field: 'effortHours', headerName: 'Effort (h)', width: 105 }, { field: 'duration', width: 100 },
    { field: 'ownerId', headerName: 'Owner', width: 150, cellEditor: 'agSelectCellEditor',
      cellEditorParams: { values: ['', ...(m.project.team?.members ?? []).map(member => member.id)] },
      valueFormatter: p => m.project.team?.members.find(member => member.id === p.value)?.name ?? 'No owner' },
    { field: 'tagsText', headerName: 'Tags', width: 180, editable: false, filter: 'agTextColumnFilter',
      filterParams: { filterOptions: ['contains', 'notContains', 'equals'], defaultOption: 'contains', maxNumConditions: 1 } },
    { field: 'durationUnit', headerName: 'Unit', width: 75, cellEditor: 'agSelectCellEditor', cellEditorParams: { values: ['d', 'h'] } },
    { field: 'scheduleMode', width: 125, cellEditor: 'agSelectCellEditor', cellEditorParams: { values: ['AUTO', 'MANUAL'] } },
    ...(['plannedStart', 'plannedFinish', 'calculatedStart', 'calculatedFinish'] as const).map(field => ({ field, width: 175,
      editable: !immutable && !field.startsWith('calculated'), valueFormatter: (p: { value?: string }) => fullDate(p.value) })),
    { field: 'predecessors', width: 180, editable: false },
    { field: 'constraintType', headerName: 'Constraint', width: 195, cellEditor: 'agSelectCellEditor', cellEditorParams: { values: ['ASAP', 'START_NO_EARLIER_THAN', 'FINISH_NO_LATER_THAN', 'MUST_START_ON', 'MUST_FINISH_ON'] } },
    { field: 'constraintDate', width: 175, valueFormatter: p => fullDate(p.value) },
    { field: 'totalSlack', headerName: 'Slack (d)', width: 100, editable: false, valueFormatter: p => num(p.value), cellClassRules: { negative: p => (p.value ?? 0) < 0 } },
    { field: 'risk', headerName: 'Risk', width: 85, editable: false, valueFormatter: p => num(p.value) },
    { field: 'status', width: 150, cellEditor: 'agSelectCellEditor', cellEditorParams: { values: ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETE'] } },
  ], [immutable, m.project.team]);
  useEffect(() => {
    api.current?.forEachNode(n => {
      const selected = !!n.data && s.selectedActivityIds.includes(n.data.id);
      if (n.isSelected() !== selected) n.setSelected(selected, false, 'api');
    });
  }, [s.selectedActivityIds, rows]);
  const selectedRows = () => rows.filter(r => s.selectedActivityIds.includes(r.id));
  const copy = async () => {
    try {
      const grid = api.current;
      if (!grid) throw new Error('Activity grid is not ready to copy.');
      const dataColumns = grid.getAllDisplayedColumns().filter(column => column.getColDef().field);
      const encode = (value: unknown) => {
        const text = String(value ?? '');
        return /[\t\r\n"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
      };
      const headers = dataColumns.map(column => encode(column.getColDef().field));
      const records = selectedRows().map(row => {
        const node = grid.getRowNode(row.id);
        if (!node) throw new Error(`Activity row not found: ${row.code}`);
        return dataColumns.map(column => encode(grid.getCellValue({ rowNode: node, colKey: column, useFormatter: false }))).join('\t');
      });
      await navigator.clipboard.writeText([headers.join('\t'), ...records].join('\n'));
      useProjectStore.setState({ notice: 'Selected rows copied as tab-separated values.' });
    } catch (error) { s.report(error); }
  };
  const applyBulk = () => {
    try {
      const patches = selectedRows().map(a => ({ id: a.id, patch: activityPatch(bulkField, bulkValue, a, s.results?.schedule.activities[a.id]?.calculatedStart ?? m.project.projectStart) }));
      applyPatches(patches);
    } catch (error) { s.report(error); }
  };
  const applyPatches = (patches: { id: string; patch: Partial<Activity> }[]) => {
    return s.updateActivityPatches(patches);
  };
  const applyPaste = () => {
    try {
      const records = parseCsv(paste, '\t');
      void persistAction(() => s.pasteActivities(records)).then(ok => { if (ok) setPasteOpen(false); });
    } catch (error) { s.report(error); }
  };
  return <section className="grid-panel" aria-label="Activity grid"><div className="panel-title"><span>ACTIVITIES <small>{rows.length} rows · double-click to edit</small></span><div>
    <button disabled={immutable} onClick={() => s.addActivity()}>+ Add row</button><button disabled={!s.selectedActivityIds.length} onClick={() => void copy()}>Copy selected</button>
    <button disabled={immutable} onClick={() => setPasteOpen(true)}>Paste TSV</button>
    <button title="Download the XLSX template with instructions and an example" onClick={() => {
      void activityTemplate(m, selectedRows()[0] ?? m.activities[0]).then(bytes =>
        download('activity-edit-template.xlsx', bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).catch(s.report);
    }}>Get Schema</button></div></div>
    {s.selectedActivityIds.length > 1 && <div className="bulk-edit"><span>{s.selectedActivityIds.length} selected</span><select aria-label="Bulk field" value={bulkField} onChange={e => setBulkField(e.target.value)}>
      {['duration', 'effortHours', 'intrinsicRisk', 'probabilityOfDelay', 'delayP80', 'plannedStart', 'plannedFinish', 'status'].map(f => <option key={f}>{f}</option>)}</select>
      <input aria-label="Bulk value" value={bulkValue} onChange={e => setBulkValue(e.target.value)} /><button disabled={immutable} onClick={applyBulk}>Apply to selected</button></div>}
    <div className="ag-container"><AgGridReact<Row> theme={theme} rowData={rows} columnDefs={columns}
      defaultColDef={{ editable: !immutable, sortable: true, filter: true, resizable: true }}
      getRowId={p => p.data.id} rowSelection={{ mode: 'multiRow', checkboxes: true, headerCheckbox: true, enableClickSelection: true }}
      readOnlyEdit onGridReady={e => { api.current = e.api; }}
      onRowDataUpdated={e => e.api.forEachNode(n => n.setSelected(!!n.data && s.selectedActivityIds.includes(n.data.id), false, 'api'))}
      onSelectionChanged={e => {
        if (e.source === 'api' || e.source === 'rowDataChanged') return;
        s.select(e.api.getSelectedRows().map(r => r.id));
      }}
      onCellEditRequest={e => {
        try {
          const field = e.colDef.field;
          if (field && e.data) s.updateActivities([e.data.id], activityPatch(field, e.newValue, e.data, e.data.calculatedStart ?? m.project.projectStart));
        } catch (error) { s.report(error); }
      }}
    /></div>
    {pasteOpen && <Modal title="Paste tab-separated activity edits" close={() => setPasteOpen(false)}>
      <p>Include a header row. Existing codes update activities; new codes create activities and require name. Omitted columns use normal new-activity defaults. Duplicate codes in the paste are rejected. All rows validate before committing, with one Undo for the entire operation.</p>
      <p>Get Schema downloads an XLSX workbook with instructions and an example. In the Template sheet, keep code and only the columns you want to change, then copy the header and data cells here. Blank cells clear/reset values; remove unused columns to leave them unchanged. Use ISO dates and IDs for ownerId/calendarId.</p>
      <textarea aria-label="TSV edits" rows={10} value={paste} onChange={e => setPaste(e.target.value)} placeholder={'code\tduration\nMIG\t18'} />
      <button className="primary" onClick={applyPaste}>Apply edits</button>
    </Modal>}
  </section>;
}
