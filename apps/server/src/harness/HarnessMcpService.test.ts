// @effect-diagnostics nodeBuiltinImport:off -- service tests use isolated native config files.
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectService from "../project/ProjectService.ts";
import * as HarnessMcp from "./HarnessMcpService.ts";
import * as HarnessMcpDeployment from "./HarnessMcpDeploymentService.ts";

const resourceId = (sourcePath: string, name: string) =>
  `mcp:${NodeCrypto.createHash("sha256")
    .update(`${NodePath.resolve(sourcePath)}\0${name}`)
    .digest("hex")
    .slice(0, 24)}`;

const serviceLayer = (homeDirectory: string, workspaceRoot: string) => {
  const begins: Array<
    Parameters<HarnessMcpDeployment.HarnessMcpDeploymentService["Service"]["beginApply"]>[0]
  > = [];
  const applied: Array<
    Parameters<HarnessMcpDeployment.HarnessMcpDeploymentService["Service"]["recordApplied"]>[0]
  > = [];
  const layer = HarnessMcp.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) => Effect.succeedSome({ id, workspaceRoot } as never),
        }),
        Layer.succeed(
          HarnessMcpDeployment.HarnessMcpDeploymentService,
          HarnessMcpDeployment.HarnessMcpDeploymentService.of({
            beginApply: (input) => {
              begins.push(input);
              return Effect.void;
            },
            recordApplied: (input) => (
              applied.push(input),
              Effect.succeed({
                ...input,
                id: "deployment-id",
                trackingOrigin: "applied" as const,
                trackedAt: "2026-10-28T00:00:00.000Z",
                updatedAt: "2026-10-28T00:00:00.000Z",
                drift: "synchronized" as const,
              })
            ),
            adopt: (input) =>
              Effect.succeed({
                ...input,
                id: "adopted-deployment",
                configurationFingerprint: "b".repeat(64),
                trackingOrigin: "adopted" as const,
                trackedAt: "2026-10-28T00:00:00.000Z",
                updatedAt: "2026-10-28T00:00:00.000Z",
                drift: "synchronized" as const,
              }),
            list: () => Effect.succeed([]),
            untrack: () => Effect.succeed(true),
          }),
        ),
        Layer.succeed(HostProcess.HomeDirectory, homeDirectory),
      ),
    ),
  );
  return { layer, begins, applied };
};

it.effect(
  "previews and applies by resource id without exposing config values or replacing other entries",
  () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hub-mcp-service-")),
      );
      return yield* Effect.gen(function* () {
        const home = NodePath.join(directory, "home");
        const project = NodePath.join(directory, "project");
        const sourcePath = NodePath.join(project, ".mcp.json");
        const targetPath = NodePath.join(project, "opencode.json");
        yield* Effect.promise(() => NodeFSP.mkdir(home));
        yield* Effect.promise(() => NodeFSP.mkdir(project));
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            sourcePath,
            JSON.stringify(
              { mcpServers: { gitlab: { command: "node", args: ["server.js"] } } },
              null,
              2,
            ),
          ),
        );
        const originalTarget = JSON.stringify(
          {
            mcp: {
              servers: {
                existing: {
                  type: "remote",
                  url: "https://keep.example/mcp",
                  headers: { Authorization: "Bearer secret-stays-in-place" },
                },
              },
              unrelatedSetting: true,
            },
            customSetting: 5,
          },
          null,
          2,
        );
        yield* Effect.promise(() => NodeFSP.writeFile(targetPath, originalTarget));
        const { layer, begins, applied: recordedDeployments } = serviceLayer(home, project);
        const result = yield* Effect.gen(function* () {
          const service = yield* HarnessMcp.HarnessMcpService;
          const preview = yield* service.preview({
            sourceResourceId: resourceId(sourcePath, "gitlab"),
            sourceScope: "project",
            sourceProjectId: "project-id",
            targetProvider: "opencode",
            targetScope: "project",
            targetProjectId: "project-id",
          });
          NodeAssert.equal(preview.status, "ready");
          NodeAssert.equal(JSON.stringify(preview).includes("server.js"), false);
          NodeAssert.equal(JSON.stringify(preview).includes("secret-stays-in-place"), false);
          const applied = yield* service.apply({
            previewId: preview.previewId!,
            confirmationToken: preview.confirmationToken!,
            confirmed: true,
          });
          NodeAssert.equal(applied.status, "distributed");
          NodeAssert.equal(applied.connectionStatus, "unknown");
          return applied;
        }).pipe(Effect.provide(layer));
        NodeAssert.equal(result.name, "gitlab");
        NodeAssert.equal(begins.length, 1);
        NodeAssert.equal(recordedDeployments.length, 1);
        NodeAssert.equal(begins[0]?.expectedFingerprint, result.configurationFingerprint);
        NodeAssert.equal(
          recordedDeployments[0]?.configurationFingerprint,
          result.configurationFingerprint,
        );
        const written = JSON.parse(
          yield* Effect.promise(() => NodeFSP.readFile(targetPath, "utf8")),
        ) as {
          mcp: {
            servers: Record<
              string,
              { type: string; command?: ReadonlyArray<string>; headers?: Record<string, string> }
            >;
            unrelatedSetting: boolean;
          };
          customSetting: number;
        };
        NodeAssert.deepEqual(written.mcp.servers.gitlab?.command, ["node", "server.js"]);
        NodeAssert.equal(
          written.mcp.servers.existing?.headers?.Authorization,
          "Bearer secret-stays-in-place",
        );
        NodeAssert.equal(written.mcp.unrelatedSetting, true);
        NodeAssert.equal(written.customSetting, 5);
      }).pipe(
        Effect.ensuring(
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
        ),
      );
    }),
);

it.effect("rejects an apply after the adopted source changes outside T3", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hub-mcp-conflict-")),
    );
    return yield* Effect.gen(function* () {
      const home = NodePath.join(directory, "home");
      const project = NodePath.join(directory, "project");
      const sourcePath = NodePath.join(project, ".mcp.json");
      const targetPath = NodePath.join(project, "opencode.json");
      yield* Effect.promise(() => NodeFSP.mkdir(home));
      yield* Effect.promise(() => NodeFSP.mkdir(project));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          sourcePath,
          JSON.stringify({ mcpServers: { gitlab: { command: "node", args: [] } } }),
        ),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(targetPath, JSON.stringify({ mcp: { servers: {} } })),
      );
      const { layer } = serviceLayer(home, project);
      yield* Effect.gen(function* () {
        const service = yield* HarnessMcp.HarnessMcpService;
        const preview = yield* service.preview({
          sourceResourceId: resourceId(sourcePath, "gitlab"),
          sourceScope: "project",
          sourceProjectId: "project-id",
          targetProvider: "opencode",
          targetScope: "project",
          targetProjectId: "project-id",
        });
        NodeAssert.equal(preview.status, "ready");
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            sourcePath,
            JSON.stringify({ mcpServers: { gitlab: { command: "changed", args: [] } } }),
          ),
        );
        const applied = yield* service.apply({
          previewId: preview.previewId!,
          confirmationToken: preview.confirmationToken!,
          confirmed: true,
        });
        NodeAssert.equal(applied.status, "conflict");
        const written = JSON.parse(
          yield* Effect.promise(() => NodeFSP.readFile(targetPath, "utf8")),
        ) as {
          mcp: { servers: Record<string, unknown> };
        };
        NodeAssert.equal(written.mcp.servers.gitlab, undefined);
      }).pipe(Effect.provide(layer));
    }).pipe(
      Effect.ensuring(
        Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
      ),
    );
  }),
);

it.effect("adopts an existing native MCP only after resolving its server-side resource id", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hub-mcp-adopt-")),
    );
    return yield* Effect.gen(function* () {
      const home = NodePath.join(directory, "home");
      const project = NodePath.join(directory, "project");
      const sourcePath = NodePath.join(project, ".mcp.json");
      yield* Effect.promise(() => NodeFSP.mkdir(home));
      yield* Effect.promise(() => NodeFSP.mkdir(project));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          sourcePath,
          JSON.stringify({ mcpServers: { gitlab: { command: "node", args: [] } } }),
        ),
      );
      const { layer } = serviceLayer(home, project);
      yield* Effect.gen(function* () {
        const service = yield* HarnessMcp.HarnessMcpService;
        const adopted = yield* service.adopt({
          sourceResourceId: resourceId(sourcePath, "gitlab"),
          sourceScope: "project",
          sourceProjectId: "project-id",
          targetProvider: "claude",
          targetScope: "project",
          targetProjectId: "project-id",
        });
        NodeAssert.equal(adopted.serverName, "gitlab");
        NodeAssert.equal(adopted.trackingOrigin, "adopted");
        const invalid = yield* Effect.flip(
          service.adopt({
            sourceResourceId: "mcp:000000000000000000000000",
            sourceScope: "project",
            sourceProjectId: "project-id",
            targetProvider: "claude",
            targetScope: "project",
            targetProjectId: "project-id",
          }),
        );
        NodeAssert.equal(invalid._tag, "HarnessError");
      }).pipe(Effect.provide(layer));
    }).pipe(
      Effect.ensuring(
        Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
      ),
    );
  }),
);
