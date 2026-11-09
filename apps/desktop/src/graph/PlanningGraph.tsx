import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, Background, Controls, MiniMap, Handle, Position, MarkerType, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react';
import type { Activity, ActivitySchedule, RiskExplanation } from '@planner/domain';
import { getAncestors } from '@planner/scheduling';
import { writeOverride } from '@planner/scenarios';
import { useProjectStore } from '../store/useProjectStore';
import { displayDate, num, riskColor, useResolved } from '../components/shared';
import '@xyflow/react/dist/style.css';

type ActivityNode = Node<{ activity: Activity; schedule?: ActivitySchedule; risk?: RiskExplanation; color: string; changed: boolean; baselineDuration?: number }, 'activity'>;
const PlanNode = memo(function PlanNode({ data: d, selected }: NodeProps<ActivityNode>) {
  const a = d.activity, s = d.schedule;
  return <div className={`plan-node ${selected ? 'selected' : ''} ${s?.critical ? 'critical' : ''} ${a.type === 'MILESTONE' ? 'milestone' : ''}`}
    style={{ borderTopColor: d.color }} title={`${a.name} - Risk Exposure Score ${num(d.risk?.totalRisk)}`}>
    <Handle type="target" position={Position.Left} />
    <div className="node-heading"><strong>{a.type === 'MILESTONE' ? '<> ' : ''}{a.code}</strong><span className="risk-chip" style={{ background: d.color }}>Risk {num(d.risk?.totalRisk)}</span></div>
    <h3>{a.name}</h3>
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
    [drag, setDrag] = useState<Record<string, { x: number; y: number }>>({}), [layoutBusy, setLayoutBusy] = useState(false);
  const canvas = useRef<HTMLDivElement>(null);
  const selectedId = s.selectedActivityIds.length === 1 ? s.selectedActivityIds[0] : undefined;
  const immutable = !!s.activeScenarioId && !!s.document.scenariosById[s.activeScenarioId]?.isBaseline;
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
    if (left < 0 || top < 0 || left + 280 * viewport.zoom > canvas.current.clientWidth || top + 190 * viewport.zoom > canvas.current.clientHeight)
      void flow.setCenter(x + 140, y + 95, { zoom: viewport.zoom, duration: 200 });
  }, [selectedId, flow, m.activities]);
  const relevant = useMemo(() => s.activeMilestoneId ? new Set([s.activeMilestoneId, ...getAncestors(s.activeMilestoneId, m.dependencies)]) : undefined, [m.dependencies, s.activeMilestoneId]);
  const baselineId = s.activeScenarioId ? s.document.scenariosById[s.activeScenarioId]?.baselineVersionId : undefined;
  const baseline = s.document.baselines.find(b => b.id === baselineId);
  const nodes: ActivityNode[] = useMemo(() => m.activities.map(a => ({
    id: a.id, type: 'activity', position: drag[a.id] ?? a.graphPosition, selected: s.selectedActivityIds.includes(a.id),
    style: { opacity: relevant && !relevant.has(a.id) ? .18 : 1 },
    data: { activity: a, schedule: s.results?.schedule.activities[a.id], risk: s.results?.risk[a.id],
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
  const layout = async () => {
    setLayoutBusy(true);
    try {
      const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
      const elk = new ELK();
      const result = await elk.layout({
        id: 'root', layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.spacing.nodeNode': '65', 'elk.layered.spacing.nodeNodeBetweenLayers': '100' },
        children: m.activities.map(a => ({ id: a.id, width: 280, height: 190 })),
        edges: m.dependencies.map(d => ({ id: d.id, sources: [d.predecessorId], targets: [d.successorId] })),
      });
      if (useProjectStore.getState().revision !== s.revision) throw new Error('Project changed during layout. Run Auto Layout again.');
      s.commit('Automatic layout', model => {
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
      <button disabled={immutable || layoutBusy} onClick={() => void layout()}>{layoutBusy ? 'Laying out...' : 'Auto Layout'}</button><button onClick={() => void flow?.fitView({ padding: .15, duration: 250 })}>Fit View</button></div></div>
    <div className="graph-canvas" ref={canvas}><ReactFlow<ActivityNode> nodes={nodes} edges={edges} nodeTypes={nodeTypes} onInit={setFlow}
      minZoom={.12} maxZoom={1.7} fitView fitViewOptions={{ padding: .15 }} onlyRenderVisibleElements nodesDraggable={!immutable} nodesConnectable={!immutable}
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
      onNodeDragStop={(_, _node, moved) => {
        s.commit('Move activities', model => {
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
      onEdgeClick={(_, edge) => s.select([], edge.id)}
      onEdgesDelete={deleted => { for (const edge of deleted) { useProjectStore.getState().select([], edge.id); useProjectStore.getState().deleteSelection(); } }}
      onPaneClick={() => s.select([])} deleteKeyCode={immutable ? null : ['Backspace', 'Delete']} selectionOnDrag>
      <Background gap={24} size={1} color="#c6d3dd" /><MiniMap pannable zoomable nodeColor={n => (n as ActivityNode).data.color} />
      <Controls showInteractive={false} />
    </ReactFlow></div>
    <div className="graph-legend"><span><i style={{ background: '#258060' }} /> Low</span><span><i style={{ background: '#b49520' }} /> Moderate</span><span><i style={{ background: '#d87b23' }} /> Elevated</span><span><i style={{ background: '#cc4e4e' }} /> High</span><span>Double border = critical</span><span>Dates in UTC</span></div>
  </section>;
}
