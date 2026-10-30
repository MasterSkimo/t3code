import * as NodeAssert from "node:assert/strict";
import { it } from "@effect/vitest";
import { proposalImplementationTime, summarizeProposalOutcome } from "./proposalOutcome.ts";

it("uses external implementation time and retains legacy applied timestamps", () => {
  NodeAssert.equal(
    proposalImplementationTime({ appliedAt: null, externallyImplementedAt: "external-time" }),
    "external-time",
  );
  NodeAssert.equal(
    proposalImplementationTime({ appliedAt: "legacy-time", externallyImplementedAt: null }),
    "legacy-time",
  );
  NodeAssert.equal(proposalImplementationTime({ appliedAt: null }), null);
});

it("reports observed run status counts without implying proposal attribution", () => {
  const outcome = summarizeProposalOutcome({
    proposalId: "proposal-1",
    implementationAt: "2026-01-02T03:04:05.000Z",
    events: [
      { status: "completed", count: 3 },
      { status: "failed", count: 2 },
    ],
  });
  NodeAssert.equal(outcome.observedCompletedEvents, 3);
  NodeAssert.equal(outcome.observedFailedEvents, 2);
  NodeAssert.match(outcome.note, /do not establish causality/);
  NodeAssert.equal(outcome.unavailableMetrics.length, 3);
});

it("leaves outcome counts unavailable without an implementation time", () => {
  const outcome = summarizeProposalOutcome({
    proposalId: "legacy",
    implementationAt: null,
    events: [],
  });
  NodeAssert.equal(outcome.observedCompletedEvents, null);
  NodeAssert.equal(outcome.observedFailedEvents, null);
  NodeAssert.equal(outcome.availableSince, null);
  NodeAssert.match(outcome.unavailableMetrics[0] ?? "", /user-marked implementation/);
});
