import {
  AuthOrchestrationOperateScope,
  type OrchestrationV2ThreadProjection,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent } from "react";

import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { plotlineEnvironment } from "../../state/plotline";
import { projectExecutionGraph, layoutExecutionGraph } from "./observerModel";

interface Props {
  readonly threadRef: ScopedThreadRef | null;
  readonly projection: OrchestrationV2ThreadProjection | null;
}

/**
 * Saves observed state to the separate Plotline database while a conversation
 * is loaded. Failure is advisory; it must never affect native T3 execution.
 */
export function PlotlineRecorder({ threadRef, projection }: Props) {
  const canPersist = useEnvironmentScope(
    threadRef?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const save = useAtomCommand(plotlineEnvironment.save, {
    reportFailure: false,
    reportDefect: false,
  });
  const persist = useEffectEvent((draft: {
    readonly environmentId: ScopedThreadRef["environmentId"];
    readonly input: Parameters<typeof plotlineEnvironment.save>[0]["input"];
  }) => {
    void save(draft);
  });

  // Include only the latest run of the thread. Historical runs have their own
  // persisted records and will not be overwritten by the next run.
  const nodes = projectExecutionGraph(projection);
  const graph = layoutExecutionGraph(nodes);
  const runId = nodes[0]?.id ?? null;
  const snapshot =
    !threadRef || !runId || !canPersist
      ? null
      : {
          environmentId: threadRef.environmentId,
          input: {
            threadId: String(threadRef.threadId),
            runId,
            title: projection?.thread.title ?? "Conversation",
            nodes: nodes.map((node) => ({
              ...node,
              // Limit prompt/result retention in fork-owned storage.
              detail: node.detail.slice(0, 1024),
              result: node.result?.slice(0, 2048) ?? null,
            })),
            edges: graph.edges,
          },
        };
  const serialized = snapshot ? JSON.stringify(snapshot) : null;
  useEffect(() => {
    if (serialized === null) return;
    // Debounce T3's high-frequency run and subagent projection updates.
    const timeout = setTimeout(() => {
      persist(JSON.parse(serialized) as NonNullable<typeof snapshot>);
    }, 600);
    return () => clearTimeout(timeout);
  }, [serialized]);
  return null;
}
