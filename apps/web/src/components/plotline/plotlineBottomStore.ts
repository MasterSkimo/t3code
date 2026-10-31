import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

/** Fork-owned presentation state; never changes native orchestration or terminals. */
interface PlotlineBottomState {
  readonly activeByThread: Readonly<Record<string, boolean>>;
  readonly open: (threadRef: ScopedThreadRef) => void;
  readonly close: (threadRef: ScopedThreadRef) => void;
}

export const usePlotlineBottomStore = create<PlotlineBottomState>((set) => ({
  activeByThread: {},
  open: (threadRef) => set((state) => ({
    activeByThread: { ...state.activeByThread, [scopedThreadKey(threadRef)]: true },
  })),
  close: (threadRef) => set((state) => ({
    activeByThread: { ...state.activeByThread, [scopedThreadKey(threadRef)]: false },
  })),
}));
