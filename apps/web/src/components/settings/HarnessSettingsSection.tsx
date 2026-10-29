import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope, type HarnessDefaults } from "@t3tools/contracts";
import { useState } from "react";
import type { HarnessProposalOutcome } from "@t3tools/contracts";
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
  const setDefaults = useAtomCommand(serverEnvironment.setHarnessDefaults, { reportFailure: true });
  const approve = useAtomCommand(serverEnvironment.approveHarnessProposal, { reportFailure: true });
  const reject = useAtomCommand(serverEnvironment.rejectHarnessProposal, { reportFailure: true });
  const rollback = useAtomCommand(serverEnvironment.rollbackHarnessProposal, {
    reportFailure: true,
  });
  const exportApproved = useAtomCommand(serverEnvironment.exportHarnessProposal, {
    reportFailure: true,
  });
  const evaluate = useAtomCommand(serverEnvironment.evaluateHarnessProposal, {
    reportFailure: true,
  });
  const markImplemented = useAtomCommand(
    serverEnvironment.markHarnessProposalImplementedExternally,
    { reportFailure: true },
  );
  const analyze = useAtomCommand(serverEnvironment.analyzeHarness, { reportFailure: true });
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<Readonly<Record<string, HarnessProposalOutcome>>>({});
  const proposals = proposalsQuery.data?.proposals ?? [];
  const lastLearnedAt = auditQuery.data?.entries.findLast(
    (entry) => entry.action === "created",
  )?.at;
  const refresh = () => {
    proposalsQuery.refresh();
    defaultsQuery.refresh();
    auditQuery.refresh();
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
          : [proposalsQuery.error, defaultsQuery.error, auditQuery.error]
              .filter((value): value is string => Boolean(value))
              .join(" ") || null
      }
      audit={auditQuery.data?.entries ?? []}
      outcomes={outcomes}
      onEvaluate={async (id) => {
        if (!environmentId) return;
        const result = await evaluate({
          environmentId,
          input: { id },
        });
        if (result._tag === "Success")
          setOutcomes((current) => ({ ...current, [id]: result.value }));
      }}
      onMarkImplemented={(id) =>
        run(() => markImplemented({ environmentId: environmentId!, input: { id } }))
      }
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
      onRollback={(id) => run(() => rollback({ environmentId: environmentId!, input: { id } }))}
      onExport={async (proposal) => {
        if (proposal.status !== "approved")
          throw new Error("Only approved proposals can be exported.");
        const result = await exportApproved({
          environmentId: environmentId!,
          input: { id: proposal.id },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        return result.value;
      }}
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
