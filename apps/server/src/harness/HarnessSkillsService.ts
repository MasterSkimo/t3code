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
  applySkillMerge,
  applySkillChange,
  commitSkillChange,
  defaultSkillRoots,
  discoverSkills,
  recoverSkillChange,
  rollbackSkillChange,
  skillMetadata,
  type DiscoveredSkill,
  type SkillChangeReceipt,
} from "./skills.ts";

export class HarnessSkillsService extends Context.Service<
  HarnessSkillsService,
  {
    readonly discover: (
      scope: HarnessProposal["scope"],
    ) => Effect.Effect<ReadonlyArray<DiscoveredSkill>, HarnessError>;
    readonly apply: (proposal: HarnessProposal) => Effect.Effect<SkillChangeReceipt, HarnessError>;
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

  const targetSkill = Effect.fn("HarnessSkillsService.targetSkill")(function* (
    proposal: HarnessProposal,
    skills: ReadonlyArray<DiscoveredSkill>,
  ) {
    if (proposal.targetSkillIds.length !== 1) {
      return yield* fail("This Harness operation must target exactly one skill.", proposal.id);
    }
    const target = skills.find((skill) => skill.id === proposal.targetSkillIds[0]);
    if (!target || !target.managed) {
      return yield* fail(
        "Only an unchanged Harness-managed skill can be updated or archived.",
        proposal.id,
      );
    }
    return target;
  });

  const apply: HarnessSkillsService["Service"]["apply"] = Effect.fn("HarnessSkillsService.apply")(
    function* (proposal) {
      if (proposal.status !== "approved")
        return yield* fail("Only approved proposals can be applied.", proposal.id);
      const root = yield* resolveRoot(proposal.scope, proposal.id);
      const skills = yield* promise(proposal.id, () =>
        discoverSkills([
          { path: root, scope: proposal.scope.kind === "global" ? "user" : "project" },
        ]),
      );

      if (proposal.operation === "create") {
        if (
          proposal.targetSkillIds.length !== 0 ||
          proposal.contentDiff.before !== null ||
          proposal.contentDiff.after === null
        ) {
          return yield* fail(
            "Create proposal content is incomplete or has an invalid target.",
            proposal.id,
          );
        }
        if (
          skillMetadata(proposal.contentDiff.after, proposal.skillName).name !== proposal.skillName
        ) {
          return yield* fail("Create proposal skill name does not match its content.", proposal.id);
        }
        const folderId = `harness-${proposal.id}`;
        return yield* promise(proposal.id, () =>
          applySkillChange(
            root,
            {
              kind: "write",
              id: folderId,
              name: proposal.skillName || folderId,
              content: proposal.contentDiff.after!,
            },
            proposal.id,
          ),
        );
      }

      if (proposal.operation === "merge") {
        if (
          proposal.targetSkillIds.length < 2 ||
          proposal.contentDiff.before === null ||
          proposal.contentDiff.after === null
        ) {
          return yield* fail(
            "Merge proposals must target at least two skills and include complete before and after content.",
            proposal.id,
          );
        }
        const targets = proposal.targetSkillIds.map((id) =>
          skills.find((skill) => skill.id === id),
        );
        if (targets.some((skill) => skill === undefined || !skill.managed)) {
          return yield* fail("Only Harness-managed skills can be merged.", proposal.id);
        }
        const resolvedTargets = targets as Array<DiscoveredSkill>;
        if (
          skillMetadata(proposal.contentDiff.after, proposal.skillName).name !== proposal.skillName
        ) {
          return yield* fail("Merge proposal skill name does not match its content.", proposal.id);
        }
        return yield* promise(proposal.id, () =>
          applySkillMerge(
            root,
            resolvedTargets.map((skill) => ({
              id: NodePath.basename(NodePath.dirname(skill.path)),
              content: skill.content,
            })),
            proposal.skillName,
            proposal.contentDiff.after!,
            proposal.id,
          ),
        );
      }

      const target = yield* targetSkill(proposal, skills);
      const folderId = NodePath.basename(NodePath.dirname(target.path));
      if (proposal.operation === "archive") {
        if (proposal.contentDiff.after !== null)
          return yield* fail("Archive proposals cannot replace skill content.", proposal.id);
        if (proposal.contentDiff.before === null) {
          return yield* fail("Archive proposal is missing its target baseline.", proposal.id);
        }
        return yield* promise(proposal.id, () =>
          applySkillChange(root, { kind: "archive", id: folderId }, proposal.id, target.content),
        );
      }
      if (proposal.contentDiff.before === null || proposal.contentDiff.after === null) {
        return yield* fail("Update proposal is missing its before or after content.", proposal.id);
      }
      if (
        skillMetadata(proposal.contentDiff.after, proposal.skillName).name !== proposal.skillName
      ) {
        return yield* fail("Update proposal skill name does not match its content.", proposal.id);
      }
      return yield* promise(proposal.id, () =>
        applySkillChange(
          root,
          {
            kind: "write",
            id: folderId,
            name: proposal.skillName || target.name,
            content: proposal.contentDiff.after!,
          },
          proposal.id,
          target.content,
        ),
      );
    },
  );

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

  return HarnessSkillsService.of({ discover, apply, rollback, commit, recover });
});

export const layer = Layer.effect(HarnessSkillsService, make);
