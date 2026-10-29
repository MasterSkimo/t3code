// @effect-diagnostics nodeBuiltinImport:off -- filesystem lifecycle tests need temporary dirs.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectService from "../project/ProjectService.ts";
import * as HarnessSkills from "./HarnessSkillsService.ts";

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

it.effect("provides read-only skill context without creating installation directories", () =>
  withTempDirectory((directory) =>
    Effect.gen(function* () {
      const home = NodePath.join(directory, "home");
      const project = NodePath.join(directory, "project");
      const skills = yield* Effect.gen(function* () {
        const service = yield* HarnessSkills.HarnessSkillsService;
        return yield* service.discover({ kind: "global" });
      }).pipe(Effect.provide(serviceLayer(home, project)));
      NodeAssert.deepEqual(skills, []);
      yield* Effect.promise(() =>
        NodeAssert.rejects(NodeFS.promises.access(NodePath.join(home, ".agents", "skills"))),
      );
      yield* Effect.promise(() =>
        NodeAssert.rejects(NodeFS.promises.access(NodePath.join(project, ".agents", "skills"))),
      );
    }),
  ),
);
