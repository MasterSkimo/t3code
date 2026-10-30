// @effect-diagnostics nodeBuiltinImport:off -- path basenames are used only for server-resolved skill directories.
import { ProjectId, type HarnessProposal, HarnessError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodePath from "node:path";

import * as ProjectService from "../project/ProjectService.ts";
import {
  commitSkillChange,
  defaultSkillRoots,
  discoverSkills,
  recoverSkillChange,
  rollbackSkillChange,
  type DiscoveredSkill,
  type SkillChangeReceipt,
} from "./skills.ts";

export class HarnessSkillsService extends Context.Service<
  HarnessSkillsService,
  {
    readonly discover: (
      scope: HarnessProposal["scope"],
    ) => Effect.Effect<ReadonlyArray<DiscoveredSkill>, HarnessError>;
    readonly commit: (
      scope: HarnessProposal["scope"],
      receipt: SkillChangeReceipt,
    ) => Effect.Effect<void, HarnessError>;
    readonly recover: (
      scope: HarnessProposal["scope"],
      transactionId: string,
    ) => Effect.Effect<void, HarnessError>;
    readonly rollback: (
      scope: HarnessProposal["scope"],
      receipt: SkillChangeReceipt,
    ) => Effect.Effect<void, HarnessError>;
  }
>()("t3/harness/HarnessSkillsService") {}

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const fail = (message: string, proposalId?: string) =>
    new HarnessError({ message, ...(proposalId === undefined ? {} : { proposalId }) });
  const promise = <A>(proposalId: string | undefined, operation: () => Promise<A>) =>
    Effect.tryPromise({
      try: operation,
      catch: () => fail("Harness could not safely read or write skills.", proposalId),
    });

  const resolveRoot = Effect.fn("HarnessSkillsService.resolveRoot")(function* (
    scope: HarnessProposal["scope"],
    proposalId?: string,
  ) {
    if (scope.kind === "global") {
      const home = yield* HostProcess.HomeDirectory;
      return NodePath.join(home, ".agents", "skills");
    }
    const result = yield* projects
      .getById(ProjectId.make(scope.projectId))
      .pipe(Effect.mapError(() => fail("Harness project could not be resolved.", proposalId)));
    const project = Option.getOrUndefined(result);
    if (!project) return yield* fail("Harness project was not found.", proposalId);
    const home = yield* HostProcess.HomeDirectory;
    return defaultSkillRoots(project.workspaceRoot, home)[0]!.path;
  });

  const discover: HarnessSkillsService["Service"]["discover"] = Effect.fn(
    "HarnessSkillsService.discover",
  )(function* (scope) {
    const root = yield* resolveRoot(scope);
    const rootScope = scope.kind === "global" ? "user" : "project";
    return yield* promise(undefined, () => discoverSkills([{ path: root, scope: rootScope }]));
  });

  const rollback: HarnessSkillsService["Service"]["rollback"] = Effect.fn(
    "HarnessSkillsService.rollback",
  )(function* (scope, receipt) {
    const root = yield* resolveRoot(scope);
    return yield* promise(undefined, () => rollbackSkillChange(root, receipt));
  });

  const commit: HarnessSkillsService["Service"]["commit"] = Effect.fn(
    "HarnessSkillsService.commit",
  )(function* (scope, receipt) {
    const root = yield* resolveRoot(scope);
    return yield* promise(undefined, () => commitSkillChange(root, receipt));
  });

  const recover: HarnessSkillsService["Service"]["recover"] = Effect.fn(
    "HarnessSkillsService.recover",
  )(function* (scope, transactionId) {
    const root = yield* resolveRoot(scope);
    return yield* promise(undefined, () => recoverSkillChange(root, transactionId));
  });

  return HarnessSkillsService.of({ discover, rollback, commit, recover });
});

export const layer = Layer.effect(HarnessSkillsService, make);
