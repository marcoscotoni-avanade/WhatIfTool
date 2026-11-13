import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, Background, Controls, MiniMap, Handle, Position, MarkerType, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react';
import { isTauri, invoke } from '@tauri-apps/api/core';
import type { Activity, ActivitySchedule, RiskExplanation } from '@planner/domain';
import { getAncestors } from '@planner/scheduling';
import { writeOverride } from '@planner/scenarios';
import { connection, persistAction, useProjectStore } from '../store/useProjectStore';
import { displayDate, num, riskColor, useResolved } from '../components/shared';
import { download } from '../persistence/local';
import '@xyflow/react/dist/style.css';

type ActivityNode = Node<{ activity: Activity; ownerName?: string; schedule?: ActivitySchedule; risk?: RiskExplanation; color: string; changed: boolean; baselineDuration?: number }, 'activity'>;
const estimatedNodeHeight = (activity: Activity) => {
  if (activity.type !== 'TASK') return 190;
  let height = 190 + (activity.ownerId ? 16 : 0), rowWidth = 0, rows = 0;
  for (const tag of activity.tags ?? []) {
    const tagWidth = Math.min(250, tag.length * 6 + 16);
    if (rowWidth && rowWidth + tagWidth > 250) { rows++; rowWidth = 0; }
    if (!rows) rows = 1;
    rowWidth = rowWidth ? rowWidth + tagWidth + 4 : tagWidth;
  }
  return height + rows * 20;
};
const PlanNode = memo(function PlanNode({ data: d, selected }: NodeProps<ActivityNode>) {
  const a = d.activity, s = d.schedule;
  return <div className={`plan-node ${selected ? 'selected' : ''} ${s?.critical ? 'critical' : ''} ${a.type === 'MILESTONE' ? 'milestone' : ''}`}
    style={{ borderTopColor: d.color }} title={`${a.name} - Risk Exposure Score ${num(d.risk?.totalRisk)}`}>
    <Handle type="target" position={Position.Left} />
    <div className="node-heading"><strong>{a.type === 'MILESTONE' ? '<> ' : ''}{a.code}</strong><span className="risk-chip" style={{ background: d.color }}>Risk {num(d.risk?.totalRisk)}</span></div>
    <h3>{a.name}</h3>
    {a.type === 'TASK' && <>{d.ownerName && <div className="node-owner">Owner <b>{d.ownerName}</b></div>}
      {!!a.tags?.length && <div className="node-tags" aria-label="Task tags">{a.tags.map(tag => <span className="task-tag-chip" key={tag}>{tag}</span>)}</div>}</>}
    <div className="node-metrics"><span>Effort <b>{a.effortHours}h</b></span><span>Duration <b className={d.changed ? 'changed' : ''}>{d.changed && d.baselineDuration !== undefined ? `${d.baselineDuration} -> ` : ''}{a.duration}{a.durationUnit}</b></span></div>
    <div className="node-dates"><span>Planned</span><b>{displayDate(a.plannedStart)} - {displayDate(a.plannedFinish)}</b>
      <span>Calculated</span><b>{displayDate(s?.calculatedStart)} - {displayDate(s?.calculatedFinish)}</b></div>
    <div className="node-footer"><span className={(s?.totalSlack ?? 0) < 0 ? 'negative' : ''}>Slack <b>{num(s?.totalSlack)}d</b></span>
      <span>{s?.violations.length ? '! Conflict | ' : s?.critical ? 'Critical | ' : ''}{a.status?.replaceAll('_', ' ') ?? 'NOT STARTED'}</span></div>
    <Handle type="source" position={Position.Right} />
  </div>;
});
const nodeTypes = { activity: PlanNode };

export function PlanningGraph() {
  const m = useResolved(), s = useProjectStore(), [flow, setFlow] = useState<ReactFlowInstance<ActivityNode>>(),
    [drag, setDrag] = useState<Record<string, { x: number; y: number }>>({}), [layoutBusy, setLayoutBusy] = useState(false),
    [exportFormat, setExportFormat] = useState<'png' | 'svg'>(),
    [contextMenu, setContextMenu] = useState<{ activityId?: string; graphPosition?: { x: number; y: number }; x: number; y: number }>();
  const canvas = useRef<HTMLDivElement>(null);
  const selectedId = s.selectedActivityIds.length === 1 ? s.selectedActivityIds[0] : undefined;
  const immutable = !!s.activeScenarioId && !!s.document.scenariosById[s.activeScenarioId]?.isBaseline;
  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.graph-context-menu')) setContextMenu(undefined);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setContextMenu(undefined); };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [contextMenu]);
  useEffect(() => {
    setDrag({});
    const timer = setTimeout(() => { void flow?.fitView({ padding: .15, duration: 200 }); }, 150);
    return () => clearTimeout(timer);
  }, [m.project.id, s.activeScenarioId, flow]);
  useEffect(() => {
    if (!selectedId || !flow || !canvas.current) return;
    const activity = m.activities.find(a => a.id === selectedId);
    if (!activity) return;
    const viewport = flow.getViewport(), { x, y } = activity.graphPosition;
    const left = x * viewport.zoom + viewport.x, top = y * viewport.zoom + viewport.y;
    const nodeHeight = estimatedNodeHeight(activity);
    if (left < 0 || top < 0 || left + 280 * viewport.zoom > canvas.current.clientWidth || top + nodeHeight * viewport.zoom > canvas.current.clientHeight)
      void flow.setCenter(x + 140, y + nodeHeight / 2, { zoom: viewport.zoom, duration: 200 });
  }, [selectedId, flow, m.activities]);
  const relevant = useMemo(() => s.activeMilestoneId ? new Set([s.activeMilestoneId, ...getAncestors(s.activeMilestoneId, m.dependencies)]) : undefined, [m.dependencies, s.activeMilestoneId]);
  const baselineId = s.activeScenarioId ? s.document.scenariosById[s.activeScenarioId]?.baselineVersionId : undefined;
  const baseline = s.document.baselines.find(b => b.id === baselineId);
  const nodes: ActivityNode[] = useMemo(() => m.activities.map(a => ({
    id: a.id, type: 'activity', position: drag[a.id] ?? a.graphPosition, selected: s.selectedActivityIds.includes(a.id),
    style: { opacity: relevant && !relevant.has(a.id) ? .18 : 1 },
    data: { activity: a, ownerName: a.type === 'TASK' ? m.project.team?.members.find(member => member.id === a.ownerId)?.name : undefined,
      schedule: s.results?.schedule.activities[a.id], risk: s.results?.risk[a.id],
      color: riskColor(s.results?.risk[a.id]?.totalRisk ?? 0, m.settings.riskColorThresholds),
      changed: !!s.activeScenarioId && a.duration !== baseline?.snapshot.activities.find(x => x.id === a.id)?.duration,
      baselineDuration: baseline?.snapshot.activities.find(x => x.id === a.id)?.duration },
  })), [m, s.results, s.selectedActivityIds, drag, relevant, baseline, s.activeScenarioId]);
  const edges = useMemo(() => m.dependencies.map(d => {
    const transmission = s.results?.risk[d.successorId]?.contributors.find(c => c.dependencyId === d.id)?.transmittedRisk ?? 0;
    const color = s.riskFlow ? riskColor(transmission, [10, 25, 45]) : '#7b91a2';
    const lag = d.lag ? `${d.lag > 0 ? '+' : ''}${d.lag}${d.lagUnit}` : '';
    return { id: d.id, source: d.predecessorId, target: d.successorId, selected: d.id === s.selectedDependencyId,
      label: `${d.type}${lag}${s.riskFlow ? ` | ${num(transmission)}%` : ''}`,
      animated: s.riskFlow && transmission > 10, markerEnd: { type: MarkerType.ArrowClosed, color },
      style: { stroke: color, strokeWidth: s.riskFlow ? 1.5 + transmission / 10 : 1.8,
        opacity: relevant && (!relevant.has(d.predecessorId) || !relevant.has(d.successorId)) ? .12 : 1 },
      labelStyle: { fontSize: 11, fill: '#243c4f' }, labelBgStyle: { fill: '#f5f8fa', fillOpacity: .96 },
    };
  }), [m.dependencies, s.results, s.riskFlow, s.selectedDependencyId, relevant]);
  const exportGraph = async (format: 'png' | 'svg') => {
    if (!canvas.current || !flow) throw new Error('The dependency map is not ready to export.');
    setExportFormat(format);
    try {
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const viewport = canvas.current.querySelector<HTMLElement>('.react-flow__viewport');
      const graphNodes = flow.getNodes();
      if (!viewport || !graphNodes.length) throw new Error('There are no activities to export.');
      if (graphNodes.some(node => {
        const measured = flow.getInternalNode(node.id)?.measured;
        return !measured?.width || !measured?.height;
      }))
        throw new Error('The dependency map is still loading. Try exporting again.');
      const bounds = flow.getNodesBounds(graphNodes.map(node => node.id));
      const padding = 80, pixelRatio = 2;
      const width = Math.ceil(bounds.width + padding * 2), height = Math.ceil(bounds.height + padding * 2);
      if (format === 'png' && (width * pixelRatio > 16384 || height * pixelRatio > 16384 || width * height * pixelRatio ** 2 > 64_000_000))
        throw new Error('The dependency map is too large for PNG export. Use Export SVG instead.');
      const { toBlob, toSvg } = await import('html-to-image');
      const options = {
        width, height,
        cacheBust: true,
        backgroundColor: '#edf3f7',
        style: { width: `${width}px`, height: `${height}px`, transform: `translate(${padding - bounds.x}px, ${padding - bounds.y}px) scale(1)` },
      };
      const image = format === 'png'
        ? await toBlob(viewport, { ...options, pixelRatio, skipAutoScale: true })
        : new Blob([decodeURIComponent((await toSvg(viewport, options)).split(',')[1]!)], { type: 'image/svg+xml;charset=utf-8' });
      if (!image) throw new Error('Could not render the dependency map as an image.');
      const projectName = m.project.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'project';
      const filename = `${projectName}-dependency-map.${format}`;
      const bytes = new Uint8Array(await image.arrayBuffer());
      if (isTauri()) {
        const { save } = await import('@tauri-apps/plugin-dialog');
        const path = await save({ defaultPath: filename, filters: [{ name: `${format.toUpperCase()} image`, extensions: [format] }] });
        if (path) await invoke('write_project', { path, bytes: Array.from(bytes) });
      } else download(filename, bytes, image.type);
    } finally {
      setExportFormat(undefined);
    }
  };
  const layout = async () => {
    setLayoutBusy(true);
    try {
      const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
      const elk = new ELK();
      const result = await elk.layout({
        id: 'root', layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.spacing.nodeNode': '65', 'elk.layered.spacing.nodeNodeBetweenLayers': '100' },
        children: m.activities.map(a => ({ id: a.id, width: 280, height: estimatedNodeHeight(a) })),
        edges: m.dependencies.map(d => ({ id: d.id, sources: [d.predecessorId], targets: [d.successorId] })),
      });
      if (useProjectStore.getState().revision !== s.revision) throw new Error('Project changed during layout. Run Auto Layout again.');
      if (connection.connected()) {
        if (!await persistAction(() => s.updateActivityPatches((result.children ?? []).map(n => ({
          id: n.id, patch: { graphPosition: { x: n.x ?? 0, y: n.y ?? 0 } },
        }))))) return;
      } else s.commit('Automatic layout', model => {
        const scenarioId = s.activeScenarioId;
        // Layout is a normal reversible edit, including scenario-specific positions.
        for (const n of result.children ?? []) {
          if (scenarioId) {
            writeOverride(model, scenarioId, 'activity', n.id, 'graphPosition', { x: n.x ?? 0, y: n.y ?? 0 });
          } else model.activities.find(a => a.id === n.id)!.graphPosition = { x: n.x ?? 0, y: n.y ?? 0 };
        }
        return model;
      });
      setTimeout(() => { void flow?.fitView({ padding: .15, duration: 250 }); }, 100);
    } catch (error) { s.report(error); } finally { setLayoutBusy(false); }
  };
  return <section className="graph-panel" aria-label="Dependency graph">
    <div className="panel-title"><span>DEPENDENCY MAP <small>Drag handles to connect · Shift + drag to select</small></span><div>
      <button disabled={!flow || !!exportFormat} title="Export the full map as a scalable SVG" onClick={() => void exportGraph('svg').catch(s.report)}>{exportFormat === 'svg' ? 'Exporting...' : 'Export SVG'}</button>
      <button disabled={!flow || !!exportFormat} title="Export the full map as a high-resolution PNG" onClick={() => void exportGraph('png').catch(s.report)}>{exportFormat === 'png' ? 'Exporting...' : 'Export PNG'}</button>
      <button disabled={immutable || layoutBusy} onClick={() => void layout()}>{layoutBusy ? 'Laying out...' : 'Auto Layout'}</button><button onClick={() => void flow?.fitView({ padding: .15, duration: 250 })}>Fit View</button></div></div>
    <div className="graph-canvas" ref={canvas} onPointerDown={event => {
      if (!(event.target instanceof Element) || !event.target.closest('.graph-context-menu')) setContextMenu(undefined);
    }}><ReactFlow<ActivityNode> nodes={nodes} edges={edges} nodeTypes={nodeTypes} onInit={setFlow}
      minZoom={.12} maxZoom={1.7} fitView fitViewOptions={{ padding: .15 }} onlyRenderVisibleElements={!exportFormat} nodesDraggable={!immutable} nodesConnectable={!immutable}
      onNodesChange={changes => {
        const removed = changes.filter(c => c.type === 'remove').map(c => c.id);
        if (removed.length) { s.select(removed); s.deleteSelection(); return; }
        const selections = changes.filter(c => c.type === 'select');
        if (selections.length) {
          const ids = new Set(s.selectedActivityIds);
          for (const c of selections) { if (c.selected) ids.add(c.id); else ids.delete(c.id); }
          const next = [...ids];
          if (next.length !== s.selectedActivityIds.length || next.some(id => !s.selectedActivityIds.includes(id))) s.select(next);
        }
        const positions = changes.filter(c => c.type === 'position').filter(c => c.position);
        if (positions.length) setDrag(current => ({ ...current, ...Object.fromEntries(positions.map(c => [c.id, c.position!])) }));
      }}
      onNodeContextMenu={(event, node) => {
        event.preventDefault();
        if (immutable) return;
        s.select([node.id]);
        setContextMenu({ activityId: node.id, x: Math.min(event.clientX, window.innerWidth - 200), y: Math.min(event.clientY, window.innerHeight - 100) });
      }}
      onPaneContextMenu={event => {
        event.preventDefault();
        if (immutable || !flow) return;
        const graphPosition = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
        setContextMenu({ graphPosition, x: Math.min(event.clientX, window.innerWidth - 200), y: Math.min(event.clientY, window.innerHeight - 60) });
      }}
      onNodeDragStop={(_, _node, moved) => {
        if (connection.connected()) {
          void persistAction(() => s.updateActivityPatches(moved.map(n => ({ id: n.id, patch: { graphPosition: n.position } }))));
        } else s.commit('Move activities', model => {
          for (const n of moved) {
            if (s.activeScenarioId) {
              writeOverride(model, s.activeScenarioId, 'activity', n.id, 'graphPosition', n.position);
            } else model.activities.find(a => a.id === n.id)!.graphPosition = n.position;
          }
          return model;
        });
        setDrag({});
      }}
      onConnect={connection => { if (connection.source && connection.target) s.connect(connection.source, connection.target); }}
      onNodeClick={() => setContextMenu(undefined)}
      onEdgeClick={(_, edge) => s.select([], edge.id)}
      onEdgesDelete={deleted => { void (async () => {
        for (const edge of deleted) {
          useProjectStore.getState().select([], edge.id);
          if (!await persistAction(() => useProjectStore.getState().deleteSelection())) break;
        }
      })(); }}
      onPaneClick={() => s.select([])} deleteKeyCode={immutable ? null : ['Backspace', 'Delete']} selectionOnDrag>
      <Background gap={24} size={1} color="#c6d3dd" /><MiniMap pannable zoomable nodeColor={n => (n as ActivityNode).data.color} />
      <Controls showInteractive={false} />
    </ReactFlow>
    {contextMenu && <div className="graph-context-menu" role="menu" aria-label="Task card actions"
      style={{ left: contextMenu.x, top: contextMenu.y }}>
        {contextMenu.activityId && <button role="menuitem" onClick={() => { setContextMenu(undefined); s.duplicateSelection(); }}>Duplicate task card</button>}
      <button role="menuitem" onClick={() => {
          const activity = contextMenu.activityId ? m.activities.find(a => a.id === contextMenu.activityId) : undefined;
          const graphPosition = activity
            ? { x: activity.graphPosition.x + 330, y: activity.graphPosition.y }
            : contextMenu.graphPosition;
          setContextMenu(undefined);
          if (graphPosition) s.addActivity(false, graphPosition);
        }}>New task card</button>
    </div>}</div>
    <div className="graph-legend"><span><i style={{ background: '#258060' }} /> Low</span><span><i style={{ background: '#b49520' }} /> Moderate</span><span><i style={{ background: '#d87b23' }} /> Elevated</span><span><i style={{ background: '#cc4e4e' }} /> High</span><span>Double border = critical</span><span>Dates in UTC</span></div>
  </section>;
}
