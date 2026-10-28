import * as NodeAssert from "node:assert/strict";
import * as DateTime from "effect/DateTime";
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import { it } from "@effect/vitest";

import { makeLoopGuardCollector } from "./loopGuard.ts";

// Focus on deterministic guard decisions; no provider runtime or model calls are needed.
const occurrence = DateTime.unsafeMake("2026-10-28T00:00:00Z");
function event(
  id: string, type: string, payload: Record<string, unknown>,
): OrchestrationV2DomainEvent {
  return { id, threadId: "thread-1", runId: "run-1", occurredAt: occurrence,
    type, payload } as unknown as OrchestrationV2DomainEvent;
}
function command(id: number, input = "npm test", exitCode = 1) {
  return event(`tool-${id}`, "turn-item.updated", {
    id: `item-${id}`, type: "command_execution", runId: "run-1",
    input, exitCode, status: "completed", outputIndicatesFailure: exitCode !== 0,
    monitor: false,
  });
}
function progress(id: number) {
  return event(`file-${id}`, "turn-item.updated", {
    id: `file-item-${id}`, type: "file_change", runId: "run-1",
    fileName: "src/index.ts", status: "completed",
  });
}

it("warns, requests recovery and escalates only after bounded identical calls", () => {
  const guard = makeLoopGuardCollector();
  const signals = Array.from({ length: 8 }, (_, i) => guard.observe(command(i + 1))).flat();
  NodeAssert.deepEqual(signals.map((signal) => signal.state),
    ["warning", "recovery", "escalated"]);
  NodeAssert.deepEqual(signals.map((signal) => signal.observedCount), [3, 5, 8]);
  NodeAssert.ok(signals.every((signal) => signal.advisoryOnly));
  NodeAssert.doesNotMatch(JSON.stringify(signals), /npm test/);
});

it("does not flag productive long-running and varied operations", () => {
  const guard = makeLoopGuardCollector();
  NodeAssert.deepEqual(guard.observe(event("start", "run.updated",
    { id: "run-1", status: "running" })), []);
  for (let i = 0; i < 20; i++) {
    NodeAssert.deepEqual(guard.observe(command(i + 1, `compile file ${i}`, 0)), []);
  }
  NodeAssert.deepEqual(guard.observe(progress(2)), []);
});

it("resolves an active warning after verified file progress", () => {
  const guard = makeLoopGuardCollector();
  for (let i = 0; i < 3; i++) guard.observe(command(i + 1));
  const signal = guard.observe(progress(1));
  NodeAssert.equal(signal[0]?.state, "resolved");
  NodeAssert.equal(signal[0]?.reason, "progress");
  NodeAssert.deepEqual(guard.observe(command(5)), []);
});

it("replayed duplicate events never advance a repetition count", () => {
  const guard = makeLoopGuardCollector();
  const duplicate = command(1);
  NodeAssert.deepEqual(guard.observe(duplicate), []);
  for (let i = 0; i < 10; i++) NodeAssert.deepEqual(guard.observe(duplicate), []);
  NodeAssert.deepEqual(guard.observe(command(2)), []);
  NodeAssert.equal(guard.observe(command(3))[0]?.state, "warning");
});

it("escalates repeated failed attempts exactly once", () => {
  const guard = makeLoopGuardCollector();
  const makeAttempt = (attempt: number) => event(`attempt-${attempt}`,
    "run-attempt.updated", {
      runId: "run-1", attemptOrdinal: attempt, status: "failed",
    });
  for (let i = 1; i <= 5; i++) NodeAssert.deepEqual(guard.observe(makeAttempt(i)), []);
  const escalated = guard.observe(makeAttempt(6));
  NodeAssert.equal(escalated[0]?.reason, "retry_budget");
  NodeAssert.equal(escalated[0]?.state, "escalated");
  NodeAssert.deepEqual(guard.observe(makeAttempt(7)), []);
});

it("a run completion resolves prior warnings without suspending the orchestrator", () => {
  const guard = makeLoopGuardCollector();
  for (let i = 0; i < 3; i++) guard.observe(command(i + 1));
  const signals = guard.observe(event("done", "run.updated", { id: "run-1", status: "completed" }));
  NodeAssert.equal(signals[0]?.state, "resolved");
  NodeAssert.ok(signals[0]?.advisoryOnly);
});
