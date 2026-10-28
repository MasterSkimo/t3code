import type { EnvironmentId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { GitBranchIcon, WorkflowIcon } from "lucide-react";

import { useRightPanelStore } from "../rightPanelStore";
import { useProjects } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { useEnvironmentQuery } from "../state/query";
import { SettingsPageContainer } from "./settings/settingsLayout";
import { PlotlineViewer } from "./plotline/PlotlineViewer";

/**
 * Backward-compatible, read-only landing page for existing /dags links.
 * Associated DAG links are handed off to their originating conversation and
 * rendered in the native right panel; legacy DAGs without an owner remain
 * inspectable here.
 */
export function PlotlineDagsPage({
  selectedDagId,
  onSelectDag,
}: {
  selectedDagId?: string | undefined;
  onSelectDag: (dagId: string | undefined) => void;
}) {
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projects = useProjects();
  const environmentId = primaryEnvironmentId ?? projects[0]?.environmentId ?? null;
  const dagsQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.plotlineDagsLive({ environmentId, input: {} }),
  );
  const dags = dagsQuery.data?.dags ?? [];
  const selectedDag = selectedDagId
    ? (dags.find((dag) => dag.id === selectedDagId) ?? null)
    : (dags[0] ?? null);
  const handedOffDagId = useRef<string | null>(null);

  // oxlint-disable-next-line t3code/react-effect-budget -- A server-loaded legacy deep link must transfer to its owning thread after the DAG record resolves.
  useEffect(() => {
    const originThreadId = selectedDag?.originatingThreadId;
    if (
      !selectedDagId ||
      !selectedDag ||
      !originThreadId ||
      environmentId === null ||
      handedOffDagId.current === selectedDag.id
    ) {
      return;
    }

    handedOffDagId.current = selectedDag.id;
    const threadRef = scopeThreadRef(environmentId as EnvironmentId, originThreadId);
    useRightPanelStore.getState().openPlotline(threadRef, selectedDag.id);
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: threadRef.environmentId, threadId: threadRef.threadId },
      replace: true,
    });
  }, [environmentId, navigate, selectedDag, selectedDagId]);

  const openTaskThread = (threadId: string) => {
    if (environmentId === null) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId },
    });
  };

  if (environmentId === null) {
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">Connect a T3 environment to view DAGs.</p>
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      <div className="mx-auto flex min-h-[min(72vh,52rem)] w-full max-w-7xl flex-col gap-4">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <WorkflowIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <h1 className="truncate text-base font-semibold">Plotline</h1>
          </div>
          {dags.length > 0 ? (
            <label className="flex min-w-0 items-center gap-2 text-sm">
              <span className="sr-only">Select a DAG</span>
              <select
                aria-label="Select a DAG"
                className="h-9 max-w-[min(24rem,70vw)] rounded-md border border-input bg-background px-3 text-sm"
                value={selectedDag?.id ?? ""}
                onChange={(event) => onSelectDag(event.target.value || undefined)}
              >
                {dags.map((dag) => (
                  <option key={dag.id} value={dag.id}>
                    {dag.title} · {dag.state}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </header>

        {dagsQuery.error ? (
          <p role="alert" className="text-sm text-destructive">
            {dagsQuery.error}
          </p>
        ) : null}

        {selectedDag ? (
          <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border">
            <PlotlineViewer
              key={selectedDag.id}
              dag={selectedDag}
              onOpenThread={openTaskThread}
              maximized
            />
          </div>
        ) : (
          <div className="flex min-h-72 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border text-center text-muted-foreground">
            <GitBranchIcon aria-hidden="true" className="size-5" />
            <p className="text-sm">
              {dagsQuery.isPending
                ? "Loading Plotline…"
                : "No DAGs are available in this environment yet."}
            </p>
          </div>
        )}
      </div>
    </SettingsPageContainer>
  );
}
