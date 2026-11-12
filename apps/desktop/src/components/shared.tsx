import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { resolveScenario } from '@planner/scenarios';
import { useProjectStore } from '../store/useProjectStore';
import { toModel } from '../store/document';

export function useResolved() {
  const document = useProjectStore(s => s.document), scenarioId = useProjectStore(s => s.activeScenarioId);
  return useMemo(() => resolveScenario(toModel(document), scenarioId), [document, scenarioId]);
}
export const displayDate = (d?: string) => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' }) : '--';
export const fullDate = (d?: string) => d ? `${d.slice(0, 10)} ${d.slice(11, 16)} UTC` : '--';
export const num = (v?: number) => v === undefined ? '--' : Number(v.toFixed(1)).toString();
export const signed = (v: number) => `${v > 0 ? '+' : ''}${num(v)}`;
export function riskColor(risk: number, thresholds: [number, number, number] = [25, 50, 75]) {
  return risk < thresholds[0] ? '#258060' : risk < thresholds[1] ? '#b49520' : risk < thresholds[2] ? '#d87b23' : '#cc4e4e';
}
export function Field({ label, value, onCommit, type = 'text', options, min, max, step = 'any', disabled = false, hint }: {
  label: string; value?: string | number; onCommit: (value: string) => void; type?: string;
  options?: string[] | { value: string; label: string }[]; min?: number; max?: number; step?: string; disabled?: boolean; hint?: string;
}) {
  const [text, setText] = useState(String(value ?? ''));
  useEffect(() => setText(String(value ?? '')), [value]);
  const commit = () => { if (text !== String(value ?? '')) { onCommit(text); setText(String(value ?? '')); } };
  return <label className="field"><span>{label}</span>{options
    ? <select aria-label={label} disabled={disabled} value={String(value ?? '')} onChange={e => onCommit(e.target.value)}>
      {options.map(o => <option key={typeof o === 'string' ? o : o.value} value={typeof o === 'string' ? o : o.value}>{typeof o === 'string' ? o : o.label}</option>)}
    </select>
    : <input aria-label={label} disabled={disabled} type={type} value={text} min={min} max={max} step={step} onChange={e => setText(e.target.value)}
      onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setText(String(value ?? '')); }} />}
    {hint && <small>{hint}</small>}</label>;
}
export function Modal({ title, children, close, wide = false, className = '' }: { title: string; children: ReactNode; close: () => void; wide?: boolean; className?: string }) {
  const closeRef = useRef(close), error = useProjectStore(s => s.error);
  useEffect(() => { closeRef.current = close; }, [close]);
  useEffect(() => {
    const previous = document.activeElement;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
      if (e.key === 'Tab') {
        const dialog = document.querySelector('[role="dialog"]');
        const focusable = [...dialog?.querySelectorAll<HTMLElement>('button:not(:disabled),input,select,textarea,[tabindex="0"]') ?? []];
        const first = focusable[0], last = focusable.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', key);
    document.querySelector<HTMLElement>('[role="dialog"] input, [role="dialog"] button')?.focus();
    return () => { document.removeEventListener('keydown', key); if (previous instanceof HTMLElement) previous.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
    <section className={`modal ${wide ? 'wide' : ''} ${className}`} role="dialog" aria-modal="true" aria-label={title}>
      <header><h2>{title}</h2><button aria-label="Close dialog" onClick={close}>X</button></header>
      {error && <div className="modal-error" role="status"><p>{error}</p><button onClick={() => useProjectStore.setState({ error: undefined })}>Dismiss message</button></div>}
      {children}
    </section>
  </div>;
}
