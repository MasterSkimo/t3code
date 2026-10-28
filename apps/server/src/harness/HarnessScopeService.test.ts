// @effect-diagnostics nodeBuiltinImport:off -- service scope tests use isolated directories.
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectService from "../project/ProjectService.ts";
import * as HarnessScope from "./HarnessScopeService.ts";

it.effect("keeps skill roots server-side and requires explicit confirmation before promotion", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      NodeFS.promises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-hub-scope-service-")),
    );
    return yield* Effect.gen(function* () {
      const home = NodePath.join(directory, "home");
      const workspace = NodePath.join(directory, "project");
      const root = NodePath.join(workspace, ".agents", "skills");
      const sourceFolder = NodePath.join(root, "linting");
      const sourcePath = NodePath.join(sourceFolder, "SKILL.md");
      const content = "---\nname: linting\n---\nRun the linter before review.\n";
      yield* Effect.promise(() => NodeFS.promises.mkdir(sourceFolder, { recursive: true }));
      yield* Effect.promise(() => NodeFS.promises.writeFile(sourcePath, content));
      const resourceId = `skill:${NodeCrypto.createHash("sha256").update(`${sourcePath}\0linting`).digest("hex").slice(0, 24)}`;
      const layer = HarnessScope.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.mock(ProjectService.ProjectService)({
              getById: () => Effect.succeedSome({ workspaceRoot: workspace } as never),
            }),
            Layer.succeed(HostProcess.HomeDirectory, home),
          ),
        ),
      );
      const result = yield* Effect.gen(function* () {
        const service = yield* HarnessScope.HarnessScopeService;
        const preview = yield* service.preview({
          projectId: "project-1",
          resourceId,
          destinationScope: "global",
        });
        NodeAssert.equal("after" in preview, true);
        NodeAssert.equal(JSON.stringify(preview).includes(directory), false);
        const rejected = yield* Effect.flip(
          service.apply({
            previewId: preview.previewId,
            confirmationToken: preview.confirmationToken,
            confirmed: false,
          }),
        );
        NodeAssert.match(rejected.message, /Explicit confirmation/);
        const applied = yield* service.apply({
          previewId: preview.previewId,
          confirmationToken: preview.confirmationToken,
          confirmed: true,
        });
        const replay = yield* Effect.flip(
          service.apply({
            previewId: preview.previewId,
            confirmationToken: preview.confirmationToken,
            confirmed: true,
          }),
        );
        NodeAssert.match(replay.message, /preview expired/);
        return applied;
      }).pipe(Effect.provide(layer));
      NodeAssert.equal(result.destinationScope, "global");
      NodeAssert.equal(
        yield* Effect.promise(() => NodeFS.promises.readFile(sourcePath, "utf8")),
        content,
      );
      NodeAssert.equal(
        yield* Effect.promise(() =>
          NodeFS.promises.readFile(
            NodePath.join(
              home,
              ".agents",
              "skills",
              "hub-" + NodeCrypto.createHash("sha256").update("linting").digest("hex").slice(0, 16),
              "SKILL.md",
            ),
            "utf8",
          ),
        ),
        content,
      );
    }).pipe(
      Effect.ensuring(
        Effect.promise(() => NodeFS.promises.rm(directory, { recursive: true, force: true })),
      ),
    );
  }),
);
