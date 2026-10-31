import {
  ThreadId as ThreadIdSchema,
  PlotlineStorageError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PlotlineStore from "../../../plotline/PlotlineStore.ts";
import { retryPendingTaskBinding } from "../../../plotline/PlotlineBindingRetry.ts";
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
    // A child can call this tool before the parent has received and bound the
    // native delegation ID. Retry the original idempotent mutation only while
    // waiting for that binding; never bypass branch ownership checks.
    return yield* retryPendingTaskBinding(
      store.mutatePlan({
        kind, rootThreadId: context.rootThreadId, actorThreadId: context.actorThreadId, input,
      } as Parameters<typeof store.mutatePlan>[0]),
      context.actorThreadId !== context.rootThreadId && kind !== "create",
    );
  });

const handlers = {
  plotline_plan_create: McpToolAccess.actsAsCaller((input) => mutate("create", input)),
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
      return yield* store.mutatePlan({
        kind: "bind", rootThreadId: context.rootThreadId, actorThreadId: context.actorThreadId,
        input: { ...input, childThreadId: task.childThreadId === null ? null : String(task.childThreadId) },
      });
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof PlotlineToolkit.tools>;

export const layer = McpToolAccess.toLayer(PlotlineToolkit, handlers);
