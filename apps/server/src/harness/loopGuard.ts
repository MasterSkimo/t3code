// @effect-diagnostics nodeBuiltinImport:off -- command signatures are hashed locally before recording.
import * as NodeCrypto from "node:crypto";
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * Observer only. OrchestratorV2 owns execution, delegation, recovery and suspension.
 * No provider tool, hook or script is executed by the detector.
 */
export type LoopGuardState = "normal" | "warning" | "recovery" | "escalated" | "resolved";
export type LoopGuardReason =
  | "repeated_tool"
  | "recurrent_failure"
  | "retry_budget";

export interface LoopGuardIntervention {
  readonly id: string;
  readonly threadId: string;
  readonly runId?: string;
  readonly at: string;
  readonly state: LoopGuardState;
  readonly reason: LoopGuardReason | "progress";
  readonly observedCount: number;
  readonly evidenceRefs: readonly string[];
  readonly recommendation: string;
  /** The observer never performs this action. */
  readonly advisoryOnly: true;
}

export interface LoopGuardPolicy {
  readonly warningAfter: number;
  readonly recoveryAfter: number;
  readonly escalationAfter: number;
  readonly maxAttempts: number;
}

/** Conservative defaults: productive progress clears the repetition sequence. */
export const DEFAULT_LOOP_GUARD_POLICY: LoopGuardPolicy = Object.freeze({
  warningAfter: 3,
  recoveryAfter: 5,
  escalationAfter: 8,
  maxAttempts: 6,
});

interface RunHistory {
  signature: string;
  count: number;
  state: LoopGuardState;
  evidence: string[];
}
const digest = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const bounded = (value: string) => value.trim().replace(/\s+/g, " ").slice(0, 16_000);

export interface LoopGuardCollector {
  readonly observe: (event: OrchestrationV2DomainEvent) => readonly LoopGuardIntervention[];
}

/** Deterministic state machine; persisted orchestration event replay reconstructs its state. */
export function makeLoopGuardCollector(
  policy: LoopGuardPolicy = DEFAULT_LOOP_GUARD_POLICY,
): LoopGuardCollector {
  if (!Number.isInteger(policy.warningAfter) || policy.warningAfter < 2 ||
      !Number.isInteger(policy.recoveryAfter) || policy.recoveryAfter <= policy.warningAfter ||
      !Number.isInteger(policy.escalationAfter) || policy.escalationAfter <= policy.recoveryAfter ||
      !Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 2) {
    throw new Error("Invalid Loop Guard policy.");
  }
  const histories = new Map<string, RunHistory>();
  const seen = new Set<string>();
  const attemptSeen = new Map<string, number>();

  function reset(event: OrchestrationV2DomainEvent, key: string): readonly LoopGuardIntervention[] {
    const previous = histories.get(key);
    histories.delete(key);
    if (!previous || previous.state === "normal") return [];
    return [{
      id: `loop-guard:${event.id}:resolved`,
      threadId: event.threadId,
      ...(event.runId ? { runId: event.runId } : {}),
      at: DateTime.formatIso(event.occurredAt),
      state: "resolved" as const,
      reason: "progress" as const,
      observedCount: previous.count,
      evidenceRefs: [event.id],
      recommendation: "Progress observed. Previous repetition warning resolved.",
      advisoryOnly: true as const,
    }];
  }

  function repeat(
    event: OrchestrationV2DomainEvent, key: string, signature: string,
    reason: LoopGuardReason,
  ): readonly LoopGuardIntervention[] {
    const previous = histories.get(key);
    const count = previous?.signature === signature ? previous.count + 1 : 1;
    const state: LoopGuardState = count >= policy.escalationAfter ? "escalated"
      : count >= policy.recoveryAfter ? "recovery"
      : count >= policy.warningAfter ? "warning" : "normal";
    const evidence = previous?.signature === signature
      ? [...previous.evidence.slice(-7), event.id] : [event.id];
    histories.delete(key);
    histories.set(key, { signature, count, state, evidence });
    if (histories.size > 1000) histories.delete(histories.keys().next().value!);
    if (state === "normal" || previous?.state === state) return [];
    const recommendation = state === "warning"
      ? "Check that work is progressing; avoid repeating identical unsuccessful calls."
      : state === "recovery"
        ? "Ask the orchestrator to change strategy before another retry."
        : "Repeated recovery was unsuccessful; request orchestrator escalation or suspension.";
    return [{
      id: `loop-guard:${event.id}:${state}`,
      threadId: event.threadId,
      ...(event.runId ? { runId: event.runId } : {}),
      at: DateTime.formatIso(event.occurredAt),
      state,
      reason,
      observedCount: count,
      evidenceRefs: evidence,
      recommendation,
      advisoryOnly: true,
    }];
  }

  const observe = (event: OrchestrationV2DomainEvent): readonly LoopGuardIntervention[] => {
    if (seen.has(event.id)) return [];
    seen.add(event.id);
    if (seen.size > 10_000) seen.delete(seen.keys().next().value!);
    const runId = event.runId ??
      ((event.type === "run.updated" || event.type === "run.created")
        ? event.payload.id : undefined);
    const key = `${event.threadId}:${runId ?? "unknown"}`;
    if (event.type === "checkpoint.captured" && event.payload.status === "ready") {
      return reset(event, key);
    }
    if (event.type === "turn-item.updated") {
      const item = event.payload;
      if (item.status !== "completed" && item.status !== "failed") return [];
      if (item.type === "file_change") return reset(event, key);
      if (item.type === "command_execution" && !item.monitor) {
        // Never retain or surface shell command text or result output, only its hash.
        const signature = digest(`command:${bounded(item.input)}:${item.exitCode ?? "unknown"}`);
        return repeat(event, key, signature,
          item.status === "failed" || item.outputIndicatesFailure || (item.exitCode ?? 0) !== 0
            ? "recurrent_failure" : "repeated_tool");
      }
      if (item.type === "file_search") {
        return repeat(event, key, digest(`file-search:${bounded(item.pattern ?? "")}`),
          "repeated_tool");
      }
      if (item.type === "web_search") {
        return repeat(event, key, digest(`web-search:${(item.patterns ?? []).map(bounded).join(";")}`),
          "repeated_tool");
      }
      if (item.type === "error") {
        return repeat(event, key,
          digest(`error:${item.failure.class}:${item.failure.code ?? ""}`),
          "recurrent_failure");
      }
    }
    if (event.type === "run-attempt.updated") {
      const attempt = event.payload;
      if (attempt.status !== "failed") return [];
      const old = attemptSeen.get(key) ?? 0;
      const count = Math.max(old, attempt.attemptOrdinal);
      attemptSeen.set(key, count);
      if (old < policy.maxAttempts && count >= policy.maxAttempts) {
        return [{
          id: `loop-guard:${event.id}:attempt-limit`, threadId: event.threadId,
          runId: attempt.runId, at: DateTime.formatIso(event.occurredAt),
          state: "escalated", reason: "retry_budget",
          observedCount: count, evidenceRefs: [event.id],
          recommendation: "Attempt budget exceeded; request orchestrator escalation.",
          advisoryOnly: true,
        }];
      }
    }
    if (event.type === "run.updated" && ["completed", "cancelled", "rolled_back"].includes(event.payload.status)) {
      return reset(event, key);
    }
    return [];
  };
  return { observe };
}
