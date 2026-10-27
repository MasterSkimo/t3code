// @effect-diagnostics nodeBuiltinImport:off -- filesystem lifecycle tests need temporary dirs and persisted skill files.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it } from "@effect/vitest";
import { HarnessProposal } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectService from "../project/ProjectService.ts";
import * as HarnessSkills from "./HarnessSkillsService.ts";
import { applySkillChange } from "./skills.ts";

const proposal = (overrides: Partial<HarnessProposal>): HarnessProposal => ({
  id: "proposal-123",
  scope: { kind: "global" },
  operation: "create",
  skillName: "release helper",
  targetSkillIds: [],
  evidence: [],
  sourceRefs: [],
  contentDiff: { before: null, after: "---\nname: release helper\n---\nDo the release" },
  engineId: "test",
  engineVersion: "1",
  confidence: 0.9,
  rationale: "Repeated use",
  status: "approved",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  decidedAt: "2026-01-01T00:00:00Z",
  decisionNote: null,
  appliedAt: null,
  appliedReceipt: null,
  ...overrides,
});

const withTempDirectory = <A, E, R>(run: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      NodeFS.promises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-harness-skill-service-")),
    );
    return yield* run(directory).pipe(
      Effect.ensuring(
        Effect.promise(() => NodeFS.promises.rm(directory, { recursive: true, force: true })),
      ),
    );
  });

function serviceLayer(home: string, projectRoot: string) {
  return HarnessSkills.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeedSome({ workspaceRoot: projectRoot } as never),
        }),
        Layer.succeed(HostProcess.HomeDirectory, home),
      ),
    ),
  );
}

it.effect("applies an approved global create and rolls it back after persisting its receipt", () =>
  withTempDirectory((directory) =>
    Effect.gen(function* () {
      const home = NodePath.join(directory, "home");
      const projectRoot = NodePath.join(directory, "project");
      const layer = serviceLayer(home, projectRoot);
      const receipt = yield* Effect.gen(function* () {
        const skills = yield* HarnessSkills.HarnessSkillsService;
        return yield* skills.apply(proposal({}));
      }).pipe(Effect.provide(layer));
      const persistedReceipt = JSON.parse(JSON.stringify(receipt)) as typeof receipt;
      const target = NodePath.join(home, ".agents", "skills", "harness-proposal-123", "SKILL.md");
      NodeAssert.equal(
        yield* Effect.promise(() => NodeFS.promises.readFile(target, "utf8")),
        "---\nname: release helper\n---\nDo the release",
      );
      yield* Effect.gen(function* () {
        const skills = yield* HarnessSkills.HarnessSkillsService;
        yield* skills.commit({ kind: "global" }, persistedReceipt);
        yield* skills.rollback({ kind: "global" }, persistedReceipt);
        yield* skills.rollback({ kind: "global" }, persistedReceipt);
      }).pipe(Effect.provide(layer));
      yield* Effect.promise(() => NodeAssert.rejects(NodeFS.promises.access(target)));
    }),
  ),
);

it.effect("rejects pending and malformed merge proposals without writing skill files", () =>
  withTempDirectory((directory) =>
    Effect.gen(function* () {
      const home = NodePath.join(directory, "home");
      const layer = serviceLayer(home, NodePath.join(directory, "project"));
      const pending = yield* Effect.gen(function* () {
        const skills = yield* HarnessSkills.HarnessSkillsService;
        return yield* Effect.flip(skills.apply(proposal({ status: "pending" })));
      }).pipe(Effect.provide(layer));
      NodeAssert.equal(pending.message, "Only approved proposals can be applied.");

      const merge = yield* Effect.gen(function* () {
        const skills = yield* HarnessSkills.HarnessSkillsService;
        return yield* Effect.flip(
          skills.apply(proposal({ operation: "merge", targetSkillIds: ["external:opaque-id"] })),
        );
      }).pipe(Effect.provide(layer));
      NodeAssert.match(merge.message, /at least two skills/);
      yield* Effect.promise(() =>
        NodeAssert.rejects(NodeFS.promises.access(NodePath.join(home, ".agents", "skills"))),
      );
    }),
  ),
);

it.effect("refuses updates to external skills", () =>
  withTempDirectory((directory) =>
    Effect.gen(function* () {
      const home = NodePath.join(directory, "home");
      const root = NodePath.join(home, ".agents", "skills");
      const externalPath = NodePath.join(root, "my-skill");
      const externalContent = "---\nname: My Skill\n---\nUser-owned";
      yield* Effect.promise(() => NodeFS.promises.mkdir(externalPath, { recursive: true }));
      yield* Effect.promise(() =>
        NodeFS.promises.writeFile(NodePath.join(externalPath, "SKILL.md"), externalContent),
      );
      const layer = serviceLayer(home, NodePath.join(directory, "project"));
      const failure = yield* Effect.gen(function* () {
        const skills = yield* HarnessSkills.HarnessSkillsService;
        const existing = yield* skills.discover({ kind: "global" });
        const update = proposal({
          operation: "update",
          skillName: "My Skill",
          targetSkillIds: [existing[0]!.id],
          contentDiff: { before: externalContent, after: "---\nname: My Skill\n---\nChanged" },
        });
        return yield* Effect.flip(skills.apply(update));
      }).pipe(Effect.provide(layer));
      NodeAssert.match(failure.message, /Harness-managed/);
      NodeAssert.equal(
        yield* Effect.promise(() =>
          NodeFS.promises.readFile(NodePath.join(externalPath, "SKILL.md"), "utf8"),
        ),
        externalContent,
      );
    }),
  ),
);

it.effect("merges fresh managed targets and restores archived sources on rollback", () =>
  withTempDirectory((directory) =>
    Effect.gen(function* () {
      const home = NodePath.join(directory, "home");
      const root = NodePath.join(home, ".agents", "skills");
      const mainContent = "---\nname: Main\n---\nMain instructions";
      const sourceContent = "---\nname: Source\n---\nSource instructions";
      yield* Effect.promise(() =>
        applySkillChange(root, { kind: "write", id: "main", name: "Main", content: mainContent }),
      );
      yield* Effect.promise(() =>
        applySkillChange(root, {
          kind: "write",
          id: "source",
          name: "Source",
          content: sourceContent,
        }),
      );
      const layer = serviceLayer(home, NodePath.join(directory, "project"));
      const restored = yield* Effect.gen(function* () {
        const skills = yield* HarnessSkills.HarnessSkillsService;
        const inventory = yield* skills.discover({ kind: "global" });
        const merge = proposal({
          operation: "merge",
          skillName: "Main",
          targetSkillIds: inventory.map(({ id }) => id),
          contentDiff: { before: mainContent, after: "---\nname: Main\n---\nMerged instructions" },
        });
        const receipt = yield* skills.apply(merge);
        yield* skills.rollback({ kind: "global" }, receipt);
        return yield* skills.discover({ kind: "global" });
      }).pipe(Effect.provide(layer));
      NodeAssert.deepEqual(restored.map(({ name }) => name).sort(), ["Main", "Source"]);
      NodeAssert.equal(
        yield* Effect.promise(() =>
          NodeFS.promises.readFile(NodePath.join(root, "main", "SKILL.md"), "utf8"),
        ),
        mainContent,
      );
      NodeAssert.equal(
        yield* Effect.promise(() =>
          NodeFS.promises.readFile(NodePath.join(root, "source", "SKILL.md"), "utf8"),
        ),
        sourceContent,
      );
    }),
  ),
);
