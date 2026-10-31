import type {
  OrchestrationV2ThreadProjection,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { X, TerminalSquare } from "lucide-react";
import { useRef, useState, type PointerEvent } from "react";

import { usePlotlineBottomStore } from "./plotlineBottomStore";
import { PlotlineObserver } from "./PlotlineObserver";

interface Props {
  readonly threadRef: ScopedThreadRef;
  readonly projection: OrchestrationV2ThreadProjection | null;
  readonly height: number;
  readonly onClosePanel: () => void;
}

/** A fork-owned Plotline tab above the chat composer, parallel to terminal drawer. */
export function PlotlineBottomDrawer({
  threadRef, projection, height, onClosePanel,
}: Props) {
  const close = usePlotlineBottomStore((state) => state.close);
  // Initial height favors the DAG. Resizing remains independent from terminal
  // height preference so the terminal reopens at its previous size.
  const [drawerHeight, setDrawerHeight] = useState(() => Math.max(480, height));
  const resize = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  const onResizeStart = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    resize.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: drawerHeight };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onResizeMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = resize.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const nextHeight = current.startHeight + current.startY - event.clientY;
    setDrawerHeight(Math.max(240, Math.min(nextHeight, window.innerHeight * 0.75)));
    event.preventDefault();
  };
  const onResizeStop = (event: PointerEvent<HTMLDivElement>) => {
    if (!resize.current || resize.current.pointerId !== event.pointerId) return;
    resize.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return (
    <section
      className="relative z-45 flex min-h-0 shrink-0 flex-col border-t border-border bg-background"
      style={{ height: `min(75vh, ${drawerHeight}px)` }}
      aria-label="Plotline bottom panel"
    >
      <div
        className="absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize"
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeStop}
        onPointerCancel={onResizeStop}
        onLostPointerCapture={onResizeStop}
      />
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 pt-1 text-xs">
        <span className="rounded-t border-b-2 border-primary px-2 py-1 font-semibold">Plotline</span>
        <button
          type="button"
          onClick={() => close(threadRef)}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-muted-foreground hover:bg-muted"
          title="Show terminal drawer"
        >
          <TerminalSquare className="size-3.5" />
          Terminal
        </button>
        <div className="flex-1" />
        <button
          type="button"
          aria-label="Close Plotline bottom panel"
          title="Close bottom panel"
          className="rounded p-1 text-muted-foreground hover:bg-muted"
          onClick={onClosePanel}
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <PlotlineObserver projection={projection} threadRef={threadRef} placement="bottom" />
      </div>
    </section>
  );
}
