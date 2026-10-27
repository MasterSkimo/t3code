import { AuthOrchestrationOperateScope, type HarnessDefaults } from "@t3tools/contracts";
import { useState } from "react";
import { usePrimaryEnvironment } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { HarnessSettingsPanel } from "./HarnessSettingsPanel";

const EMPTY_DEFAULTS: HarnessDefaults = {
  scope: { kind: "global" },
  enabled: true,
  autoLearn: true,
  engineId: "native-v1",
  modelSelection: null,
  dailyAnalysisBudget: 10,
  minimumConfidence: 0.75,
  updatedAt: "",
};

export function HarnessSettingsSection() {
  const environment = usePrimaryEnvironment();
  const environmentId = environment?.environmentId ?? null;
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const proposalsQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.harnessProposals({ environmentId, input: {} }),
  );
  const defaultsQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.harnessDefaults({ environmentId, input: { scope: { kind: "global" } } }),
  );
  const auditQuery = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.harnessAudit({ environmentId, input: {} }),
  );
  const inventoryQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.harnessInventory({ environmentId, input: { scope: { kind: "global" } } }),
  );
  const setDefaults = useAtomCommand(serverEnvironment.setHarnessDefaults, { reportFailure: true });
  const approve = useAtomCommand(serverEnvironment.approveHarnessProposal, { reportFailure: true });
  const reject = useAtomCommand(serverEnvironment.rejectHarnessProposal, { reportFailure: true });
  const apply = useAtomCommand(serverEnvironment.applyHarnessProposal, { reportFailure: true });
  const rollback = useAtomCommand(serverEnvironment.rollbackHarnessProposal, {
    reportFailure: true,
  });
  const analyze = useAtomCommand(serverEnvironment.analyzeHarness, { reportFailure: true });
  const [busy, setBusy] = useState(false);
  const proposals = proposalsQuery.data?.proposals ?? [];
  const lastLearnedAt = auditQuery.data?.entries.findLast(
    (entry) => entry.action === "created",
  )?.at;
  const refresh = () => {
    proposalsQuery.refresh();
    defaultsQuery.refresh();
    auditQuery.refresh();
    inventoryQuery.refresh();
  };

  const run = async (action: () => Promise<{ readonly _tag: "Success" | "Failure" }>) => {
    if (!environmentId || !canOperate) return;
    setBusy(true);
    try {
      const result = await action();
      if (result._tag === "Success") refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <HarnessSettingsPanel
      key={`${defaultsQuery.data?.enabled ?? "default"}:${defaultsQuery.data?.autoLearn ?? "default"}:${defaultsQuery.data?.engineId ?? "default"}:${defaultsQuery.data?.modelSelection?.model ?? "none"}:${defaultsQuery.data?.dailyAnalysisBudget ?? "default"}:${defaultsQuery.data?.minimumConfidence ?? "default"}:${defaultsQuery.data?.updatedAt ?? ""}`}
      defaults={defaultsQuery.data ?? EMPTY_DEFAULTS}
      proposals={proposals}
      notice={
        environmentId === null
          ? "Select a connected environment to manage Harness."
          : [proposalsQuery.error, defaultsQuery.error, inventoryQuery.error, auditQuery.error]
              .filter((value): value is string => Boolean(value))
              .join(" ") || null
      }
      audit={auditQuery.data?.entries ?? []}
      inventory={inventoryQuery.data?.skills ?? []}
      metrics={{
        proposalCount: proposals.length,
        approvedCount: proposals.filter((proposal) => proposal.status === "approved").length,
        appliedCount: proposals.filter((proposal) => proposal.status === "applied").length,
        rejectedCount: proposals.filter((proposal) => proposal.status === "rejected").length,
        ...(lastLearnedAt === undefined ? {} : { lastLearnedAt }),
      }}
      busy={busy || !canOperate || defaultsQuery.isPending}
      onSave={(defaults) =>
        run(() =>
          setDefaults({
            environmentId: environmentId!,
            input: {
              scope: defaults.scope,
              enabled: defaults.enabled,
              autoLearn: defaults.autoLearn,
              engineId: defaults.engineId,
              modelSelection: defaults.modelSelection,
              dailyAnalysisBudget: defaults.dailyAnalysisBudget,
              minimumConfidence: defaults.minimumConfidence,
            },
          }),
        )
      }
      onApprove={(id) => run(() => approve({ environmentId: environmentId!, input: { id } }))}
      onReject={(id) => run(() => reject({ environmentId: environmentId!, input: { id } }))}
      onApply={(id) => run(() => apply({ environmentId: environmentId!, input: { id } }))}
      onRollback={(id) => run(() => rollback({ environmentId: environmentId!, input: { id } }))}
      onLearn={(context) =>
        run(() =>
          analyze({
            environmentId: environmentId!,
            input: {
              scope: { kind: "global" },
              ...(context.length === 0 ? {} : { context }),
            },
          }),
        )
      }
    />
  );
}
