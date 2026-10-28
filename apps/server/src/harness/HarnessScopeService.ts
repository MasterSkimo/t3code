// @effect-diagnostics nodeBuiltinImport:off -- resource ids map to server-discovered files only.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import {
  HarnessError,
  ProjectId,
  type HarnessHubScopeApplyInput,
  type HarnessHubScopeHistoryEntry,
  type HarnessHubScopeHistoryInput,
  type HarnessHubScopePreviewInput,
  type HarnessHubScopePreviewResult,
  type HarnessHubScopeRollbackInput,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectService from "../project/ProjectService.ts";
import { discoverSkills, type DiscoveredSkill } from "./skills.ts";
import {
  applySkillScopeChange,
  listSkillScopeHistory,
  previewSkillScopeChange,
  recoverSkillScopeChanges,
  rollbackSkillScopeChange,
  type SkillScopePreview,
} from "./hubScope.ts";

export class HarnessScopeService extends Context.Service<
  HarnessScopeService,
  {
    readonly preview: (
      input: HarnessHubScopePreviewInput,
    ) => Effect.Effect<HarnessHubScopePreviewResult, HarnessError>;
    readonly apply: (
      input: HarnessHubScopeApplyInput,
    ) => Effect.Effect<HarnessHubScopeHistoryEntry, HarnessError>;
    readonly history: (
      input: HarnessHubScopeHistoryInput,
    ) => Effect.Effect<ReadonlyArray<HarnessHubScopeHistoryEntry>, HarnessError>;
    readonly rollback: (input: HarnessHubScopeRollbackInput) => Effect.Effect<void, HarnessError>;
  }
>()("t3/harness/HarnessScopeService") {}

const idForSkill = (skill: DiscoveredSkill) =>
  `skill:${NodeCrypto.createHash("sha256")
    .update(`${NodePath.resolve(skill.path)}\0${skill.name}`)
    .digest("hex")
    .slice(0, 24)}`;

const make = Effect.gen(function* () {
  const home = yield* HostProcess.HomeDirectory;
  const projects = yield* ProjectService.ProjectService;
  const previews = new Map<
    string,
    { readonly preview: SkillScopePreview; readonly projectId: string }
  >();
  const fail = (message: string) => new HarnessError({ message });

  const projectRoot = Effect.fn("HarnessScopeService.projectRoot")(function* (projectId: string) {
    const result = yield* projects
      .getById(ProjectId.make(projectId))
      .pipe(Effect.mapError(() => fail("Could not resolve the selected project.")));
    const project = Option.getOrUndefined(result);
    if (!project) return yield* fail("The selected project was not found.");
    return project.workspaceRoot;
  });

  const destinationRoot = Effect.fn("HarnessScopeService.destinationRoot")(function* (
    scope: "project" | "global",
    projectId: string,
  ) {
    const root = scope === "global" ? home : yield* projectRoot(projectId);
    return NodePath.join(root, ".agents", "skills");
  });

  const promise = <A>(operation: () => Promise<A>, message: string) =>
    Effect.tryPromise({ try: operation, catch: () => fail(message) });

  const preview: HarnessScopeService["Service"]["preview"] = Effect.fn(
    "HarnessScopeService.preview",
  )(function* (input) {
    const workspace = yield* projectRoot(input.projectId);
    const inventory = yield* promise(
      () =>
        discoverSkills([
          { path: NodePath.join(workspace, ".agents", "skills"), scope: "project" },
          { path: NodePath.join(home, ".agents", "skills"), scope: "user" },
        ]),
      "Could not safely inspect skill scopes.",
    );
    const source = inventory.find((skill) => idForSkill(skill) === input.resourceId);
    if (!source) return yield* fail("The selected skill is no longer available.");
    const target = yield* destinationRoot(input.destinationScope, input.projectId);
    yield* promise(
      () => recoverSkillScopeChanges(target),
      "Could not recover pending skill scope changes.",
    );
    const result = yield* promise(
      () => previewSkillScopeChange(source, target, input.destinationScope, input.destinationName),
      "Could not safely prepare the scope preview.",
    );
    previews.set(result.id, { preview: result, projectId: input.projectId });
    if (previews.size > 100) previews.delete(previews.keys().next().value!);
    return {
      previewId: result.id,
      confirmationToken: result.confirmationToken,
      sourceName: result.source.name,
      sourceScope: result.source.scope === "user" ? "global" : "project",
      destinationScope: result.destination.scope,
      destinationName: result.destination.name,
      before: result.diff.before,
      after: result.diff.after,
      conflicts: result.conflicts.map(({ name, managed }) => ({
        name,
        ownership: managed ? "managed" : "user",
      })),
    };
  });

  const apply: HarnessScopeService["Service"]["apply"] = Effect.fn("HarnessScopeService.apply")(
    function* (input) {
      if (!input.confirmed)
        return yield* fail("Explicit confirmation is required to apply this scope change.");
      const stored = previews.get(input.previewId);
      if (!stored) return yield* fail("Scope preview expired; prepare a new preview.");
      if (input.confirmationToken !== stored.preview.confirmationToken)
        return yield* fail("The confirmed preview does not match the reviewed change.");
      previews.delete(input.previewId);
      const currentRoot = yield* destinationRoot(
        stored.preview.destination.scope,
        stored.projectId,
      );
      if (currentRoot !== stored.preview.destination.root)
        return yield* fail("Project scope changed; prepare a new preview.");
      yield* promise(
        () => recoverSkillScopeChanges(currentRoot),
        "Could not recover pending skill scope changes.",
      );
      const createdAt = DateTime.formatIso(DateTime.toUtc(yield* DateTime.now));
      const entry = yield* promise(
        () =>
          applySkillScopeChange(
            stored.preview,
            input.confirmationToken,
            createdAt,
            input.resolution,
          ),
        "Could not safely apply the scope change. Review conflicts and prepare a new preview.",
      );
      previews.delete(input.previewId);
      return {
        id: entry.id,
        createdAt: entry.createdAt,
        sourceName: entry.source.name,
        sourceScope: entry.source.scope === "user" ? "global" : "project",
        destinationName: entry.destination.name,
        destinationScope: entry.destination.scope,
      };
    },
  );

  const history: HarnessScopeService["Service"]["history"] = Effect.fn(
    "HarnessScopeService.history",
  )(function* (input) {
    const root = yield* destinationRoot(input.scope, input.projectId);
    yield* promise(
      () => recoverSkillScopeChanges(root),
      "Could not recover pending skill scope changes.",
    );
    const entries = yield* promise(
      () => listSkillScopeHistory(root),
      "Could not read scope history.",
    );
    return entries.map((entry) => ({
      id: entry.id,
      createdAt: entry.createdAt,
      sourceName: entry.source.name,
      sourceScope: entry.source.scope === "user" ? "global" : "project",
      destinationName: entry.destination.name,
      destinationScope: entry.destination.scope,
    }));
  });

  const rollback: HarnessScopeService["Service"]["rollback"] = Effect.fn(
    "HarnessScopeService.rollback",
  )(function* (input) {
    const root = yield* destinationRoot(input.scope, input.projectId);
    yield* promise(
      () => recoverSkillScopeChanges(root),
      "Could not recover pending skill scope changes.",
    );
    yield* promise(
      () => rollbackSkillScopeChange(root, input.entryId),
      "Could not safely roll back this scope change.",
    );
  });

  return HarnessScopeService.of({ preview, apply, history, rollback });
});

export const layer = Layer.effect(HarnessScopeService, make);
