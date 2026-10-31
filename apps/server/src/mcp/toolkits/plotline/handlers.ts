import {
  ThreadId as ThreadIdSchema,
  PlotlineStorageError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PlotlineStore from "../../../plotline/PlotlineStore.ts";
import { findPendingNativeAssignment, retryPendingTaskBinding } from "../../../plotline/PlotlineBindingRetry.ts";
import { PlotlineToolkit } from "./tools.ts";

const failure = (message: string) => new PlotlineStorageError({ message });

/** Resolve the caller's T3 ancestor, never trust a model-supplied root ID. */
const caller = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const threads = yield* ThreadManagement.ThreadManagementService;
  if (!scope.thread) return yield* failure("An active T3 thread is required.");
  const actorThreadId = String(scope.thread.threadId);
  let rootThreadId = actorThreadId;
  const seen = new Set<string>();
  for (let depth = 0; depth < 16; depth++) {
    if (seen.has(rootThreadId)) return yield* failure("Invalid thread lineage.");
    seen.add(rootThreadId);
    const shell = yield* threads.getThreadShell(ThreadIdSchema.make(rootThreadId))
      .pipe(Effect.mapError(() => failure("Could not read calling thread.")));
    if (shell === null || shell.deletedAt !== null) return yield* failure("Calling thread no longer exists.");
    if (shell.lineage.relationshipToParent !== "subagent" || !shell.lineage.parentThreadId)
      return { rootThreadId, actorThreadId, threads };
    rootThreadId = String(shell.lineage.parentThreadId);
  }
  return yield* failure("Delegation ancestry exceeds the supported depth.");
});

const mutate = <I>(kind: "create" | "add" | "update", input: I) =>
  Effect.gen(function* () {
    const context = yield* caller;
    const store = yield* PlotlineStore.PlotlineStore;
    const isWorker = context.actorThreadId !== context.rootThreadId && kind !== "create";
    const apply = Effect.gen(function* () {
      if (isWorker) {
        const plan = yield* store.getPlan(context.rootThreadId);
        // T3 can expose a delegated-task ID while its childThreadId is still
        // null. Resolve that identity from the real native parent/child records,
        // never from agent-provided task or thread IDs.
        if (plan?.tasks.some((task) => task.boundTaskId !== null && task.boundThreadId === null)) {
          const shell = yield* context.threads.getThreadShell(ThreadIdSchema.make(context.actorThreadId))
            .pipe(Effect.mapError(() => failure("Could not inspect native child lineage.")));
          if (shell?.lineage.relationshipToParent === "subagent" && shell.lineage.parentThreadId) {
            const parentThreadId = String(shell.lineage.parentThreadId);
            const native = yield* context.threads.getThreadRecords(
              ThreadIdSchema.make(parentThreadId), ["subagents"],
            ).pipe(Effect.mapError(() => failure("Could not inspect native parent delegations.")));
            const assignment = findPendingNativeAssignment(
              plan.tasks,
              native.subagents.map((task) => ({
                id: String(task.id),
                childThreadId: task.childThreadId === null ? null : String(task.childThreadId),
              })),
              context.actorThreadId,
            );
            if (assignment)
              yield* store.mutatePlan({
                kind: "bind",
                rootThreadId: context.rootThreadId,
                actorThreadId: parentThreadId,
                input: {
                  requestId: `plotline-child-link:${assignment.delegatedTaskId}`,
                  ...assignment,
                },
              });
          }
        }
      }
      return yield* store.mutatePlan({
        kind, rootThreadId: context.rootThreadId, actorThreadId: context.actorThreadId, input,
      } as Parameters<typeof store.mutatePlan>[0]);
    });
    // A child can mutate before Terra receives the native delegation ID.
    // Retry only the temporary missing-assignment error; each attempt checks
    // the persisted plan and may repair a native child link in its own branch.
    return yield* retryPendingTaskBinding(apply, isWorker);
  });

const handlers = {
  plotline_plan_create: McpToolAccess.actsAsCaller((input) =>
    // Keep the typed MCP failure intact, but record unexpected server defects
    // and storage errors rather than leaving the agent with "internal error".
    mutate("create", input).pipe(
      Effect.tapErrorCause((cause) =>
        Effect.logError(`Plotline plan initialization failed: ${Cause.pretty(cause)}`),
      ),
    ),
  ),
  plotline_task_add: McpToolAccess.actsAsCaller((input) => mutate("add", input)),
  plotline_task_update: McpToolAccess.actsAsCaller((input) => mutate("update", input)),
  plotline_task_bind: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const context = yield* caller;
      // Verify against the actor's real thread, so a delegated worker may
      // bind only tasks it actually spawned (not sibling/root delegations).
      const records = yield* context.threads.getThreadRecords(
        ThreadIdSchema.make(context.actorThreadId), ["subagents"],
      ).pipe(Effect.mapError(() => failure("Could not inspect native delegation.")));
      const task = records.subagents.find((item) => String(item.id) === input.delegatedTaskId);
      if (!task) return yield* failure("The native T3 delegated task does not exist in this conversation.");
      const store = yield* PlotlineStore.PlotlineStore;
      const current = yield* store.getPlan(context.rootThreadId);
      const assigned = current?.tasks.find((candidate) => candidate.id === input.taskId);
      const previousId = assigned?.boundTaskId;
      const replacing = previousId !== null && previousId !== undefined &&
        previousId !== input.delegatedTaskId;
      // A native retry may replace a finished execution, but never steal the
      // binding from a running sibling or erase an earlier attempt.
      const previous = replacing
        ? records.subagents.find((item) => String(item.id) === previousId)
        : undefined;
      const previousDelegationTerminal = previous !== undefined &&
        ["completed", "failed", "cancelled", "interrupted"].includes(previous.status);
      if (replacing && !previousDelegationTerminal)
        return yield* failure("The previous native delegation is not terminal or is not owned by this thread.");
      return yield* store.mutatePlan({
        kind: "bind", rootThreadId: context.rootThreadId, actorThreadId: context.actorThreadId,
        previousDelegationTerminal,
        input: { ...input, childThreadId: task.childThreadId === null ? null : String(task.childThreadId) },
      });
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof PlotlineToolkit.tools>;

export const layer = McpToolAccess.toLayer(PlotlineToolkit, handlers);
