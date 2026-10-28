import {
  HarnessError,
  ProjectId,
  type HarnessHubListInput,
  type HarnessHubListResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ProjectService from "../project/ProjectService.ts";
import { discoverFederatedCatalog } from "./federatedCatalog.ts";

export class HarnessHubService extends Context.Service<
  HarnessHubService,
  {
    readonly list: (
      input: HarnessHubListInput,
    ) => Effect.Effect<HarnessHubListResult, HarnessError>;
  }
>()("t3/harness/HarnessHubService") {}

const make = Effect.gen(function* () {
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const projects = yield* ProjectService.ProjectService;
  const list = Effect.fn("HarnessHubService.list")(function* (input: HarnessHubListInput) {
    let workspaceRoot = homeDirectory;
    if (input.projectId !== undefined) {
      const project = yield* projects
        .getById(ProjectId.make(input.projectId))
        .pipe(Effect.mapError(() => new HarnessError({ message: "Could not resolve project." })));
      const found = Option.getOrUndefined(project);
      if (!found) return yield* new HarnessError({ message: "Project was not found." });
      workspaceRoot = found.workspaceRoot;
    }
    const resources = yield* Effect.tryPromise({
      try: () =>
        discoverFederatedCatalog({
          workspaceRoot,
          homeDirectory,
          ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        }),
      catch: () => new HarnessError({ message: "Could not discover resources." }),
    });
    return {
      resources:
        input.projectId === undefined
          ? resources.filter((resource) => resource.scope === "global")
          : resources,
    };
  });
  return HarnessHubService.of({ list });
});

export const layer = Layer.effect(HarnessHubService, make);
