import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { fittedTranscriptRatio, paneRatioBounds, PANE_DIVIDER_WIDTH, transcriptRatio } from '../../shared/appearance';

interface Drag {
  pointerId: number;
  start: number;
  startX: number;
  moved: boolean;
  offset: number;
}

export function ResizablePanes({ children, ratio, disabled, onCommit }: {
  children: [ReactNode, ReactNode];
  ratio: number | undefined;
  disabled: boolean;
  onCommit: (value: number) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const divider = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const commit = useRef(onCommit);
  commit.current = onCommit;
  const [preferred, setPreferred] = useState(() => transcriptRatio(ratio));
  const [width, setWidth] = useState(0);
  const [resizing, setResizing] = useState(false);

  useEffect(() => { if (!drag.current) setPreferred(transcriptRatio(ratio)); }, [ratio]);
  useLayoutEffect(() => {
    const node = container.current!;
    const measure = () => setWidth(node.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const actual = fittedTranscriptRatio(preferred, width);
  const [min, max] = paneRatioBounds(width);
  const positionRatio = (clientX: number) => {
    const rect = container.current!.getBoundingClientRect();
    const available = rect.width - PANE_DIVIDER_WIDTH;
    if (available <= 0) return 0.5;
    return fittedTranscriptRatio((clientX - (drag.current?.offset ?? 0) - rect.left - PANE_DIVIDER_WIDTH / 2) / available, rect.width);
  };
  const finish = (pointerId: number, clientX: number, cancelled: boolean) => {
    const current = drag.current;
    if (!current || current.pointerId !== pointerId) return;
    const moved = current.moved || Math.abs(clientX - current.startX) >= 1;
    const value = cancelled || !moved ? current.start : positionRatio(clientX);
    drag.current = null;
    setPreferred(value);
    setResizing(false);
    if (divider.current?.hasPointerCapture(pointerId)) divider.current.releasePointerCapture(pointerId);
    if (!cancelled && Math.abs(value - current.start) > 0.0001) commit.current(value);
  };

  // Pointer capture can be unavailable in a non-focusable Electron window.
  // Keep routing within this document even when release lands on another pane.
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;
      if (event.pointerType === 'mouse' && event.buttons === 0) { finish(event.pointerId, event.clientX, true); return; }
      if (Math.abs(event.clientX - current.startX) >= 1) current.moved = true;
      if (current.moved) setPreferred(positionRatio(event.clientX));
    };
    const up = (event: PointerEvent) => finish(event.pointerId, event.clientX, false);
    const cancel = (event: PointerEvent) => finish(event.pointerId, event.clientX, true);
    const cancelActive = () => { if (drag.current) finish(drag.current.pointerId, drag.current.startX, true); };
    const visibility = () => { if (document.hidden) cancelActive(); };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('blur', cancelActive);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('blur', cancelActive);
      document.removeEventListener('visibilitychange', visibility);
      drag.current = null;
    };
  }, []);

  return <div ref={container} className={`panes${resizing ? ' panes-resizing' : ''}`}
    style={{ gridTemplateColumns: `minmax(0, ${actual}fr) ${PANE_DIVIDER_WIDTH}px minmax(0, ${1 - actual}fr)` }}>
    {children[0]}
    <div ref={divider} className="pane-divider" role="separator" aria-label="调整转写与回答区域宽度" aria-orientation="vertical"
      aria-valuenow={Math.round(actual * 100)} aria-valuemin={Math.round(min * 100)} aria-valuemax={Math.round(max * 100)}
      aria-valuetext={`左侧转写 ${Math.round(actual * 100)}%，右侧回答 ${Math.round((1 - actual) * 100)}%`}
      aria-disabled={disabled} tabIndex={disabled ? -1 : 0}
      title="左右拖动调整宽度；双击恢复等宽。聚焦后可用左右方向键微调。"
      onPointerDown={event => {
        if (disabled || event.button !== 0 || !event.isPrimary || drag.current) return;
        event.preventDefault(); // Do not focus this control or activate the native window.
        const rect = event.currentTarget.getBoundingClientRect();
        drag.current = { pointerId: event.pointerId, start: preferred, startX: event.clientX, moved: false, offset: event.clientX - rect.left - rect.width / 2 };
        setResizing(true);
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* window listeners cover same-document moves */ }
      }}
      onLostPointerCapture={event => finish(event.pointerId, event.clientX, true)}
      onDoubleClick={event => {
        if (disabled) return;
        event.preventDefault();
        setPreferred(0.5); onCommit(0.5);
      }}
      onKeyDown={event => {
        if (disabled || drag.current) return;
        const step = event.shiftKey ? 0.1 : 0.02;
        const next = event.key === 'ArrowLeft' ? actual - step : event.key === 'ArrowRight' ? actual + step :
          event.key === 'Home' ? min : event.key === 'End' ? max : undefined;
        if (next === undefined) return;
        event.preventDefault();
        if (event.repeat) return;
        const value = fittedTranscriptRatio(next, width);
        setPreferred(value);
        if (Math.abs(value - actual) > 0.0001) onCommit(value);
      }}
    />
    {children[1]}
  </div>;
}
