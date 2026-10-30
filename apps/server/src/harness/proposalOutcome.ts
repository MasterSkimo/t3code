import type { HarnessProposalOutcome } from "@t3tools/contracts";

export function proposalImplementationTime(input: {
  readonly appliedAt: string | null;
  readonly externallyImplementedAt?: string | null | undefined;
}): string | null {
  return input.appliedAt ?? input.externallyImplementedAt ?? null;
}

export function summarizeProposalOutcome(input: {
  readonly proposalId: string;
  readonly implementationAt: string | null;
  readonly events: ReadonlyArray<{ readonly status: string; readonly count: number }>;
}): HarnessProposalOutcome {
  if (input.implementationAt === null) {
    return {
      proposalId: input.proposalId,
      availableSince: null,
      observedCompletedEvents: null,
      observedFailedEvents: null,
      unavailableMetrics: ["No applied or user-marked implementation time is recorded."],
      note: "Observed events cannot be attributed to a proposal and do not establish causality.",
    };
  }

  return {
    proposalId: input.proposalId,
    availableSince: input.implementationAt,
    observedCompletedEvents: input.events.find((event) => event.status === "completed")?.count ?? 0,
    observedFailedEvents: input.events.find((event) => event.status === "failed")?.count ?? 0,
    unavailableMetrics: [
      "Run outcomes are not stored as proposal-attributed counts.",
      "Validation criteria require user review; no automated criterion result is available.",
      "A user-marked implementation is not independently verified.",
    ],
    note: "Counts are server-wide run status events after the recorded application time, not proposal-attributed outcomes, and do not establish causality.",
  };
}
