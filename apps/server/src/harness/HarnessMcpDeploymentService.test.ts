// @effect-diagnostics nodeBuiltinImport:off -- service tests use isolated native config files.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectService from "../project/ProjectService.ts";
import * as Deployments from "./HarnessMcpDeploymentService.ts";
import { discoverNativeMcp } from "./hubMcp.ts";

const serviceLayer = (home: string, project: string) =>
  Deployments.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        NodeSqliteClient.layer({ filename: ":memory:" }),
        Layer.succeed(HostProcess.HomeDirectory, home),
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) => Effect.succeedSome({ id, workspaceRoot: project } as never),
        }),
      ),
    ),
  );

const initialize = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE harness_mcp_deployments (
    deployment_id TEXT PRIMARY KEY NOT NULL,
    source_resource_id TEXT NOT NULL,
    source_scope TEXT NOT NULL,
    source_project_id TEXT NOT NULL,
    target_provider TEXT NOT NULL,
    target_scope TEXT NOT NULL,
    target_project_id TEXT NOT NULL,
    server_name TEXT NOT NULL,
    configuration_fingerprint TEXT NOT NULL,
    tracking_origin TEXT NOT NULL,
    pending_fingerprint TEXT,
    pending_is_new INTEGER NOT NULL DEFAULT 0,
    tracked_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (target_provider, target_scope, target_project_id, server_name)
  )`;
  return yield* Deployments.HarnessMcpDeploymentService;
});

const input = {
  sourceResourceId: "mcp:0123456789abcdef01234567",
  sourceScope: "project" as const,
  sourceProjectId: "project-id",
  targetProvider: "claude" as const,
  targetScope: "project" as const,
  targetProjectId: "project-id",
  serverName: "gitlab",
};

it.effect("adopts explicitly, reports drift, and untracks without changing provider config", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "harness-mcp-deployments-")),
    );
    return yield* Effect.gen(function* () {
      const home = NodePath.join(directory, "home");
      const project = NodePath.join(directory, "project");
      const configPath = NodePath.join(project, ".mcp.json");
      yield* Effect.promise(() => NodeFSP.mkdir(home));
      yield* Effect.promise(() => NodeFSP.mkdir(project));
      const original = JSON.stringify(
        {
          mcpServers: {
            gitlab: {
              command: "node",
              args: ["server.js"],
              env: { API_TOKEN: "secret-value" },
            },
          },
          untouched: true,
        },
        null,
        2,
      );
      yield* Effect.promise(() => NodeFSP.writeFile(configPath, original));
      const service = yield* initialize;
      const adopted = yield* service.adopt(input);
      NodeAssert.equal(adopted.trackingOrigin, "adopted");
      NodeAssert.equal(adopted.drift, "synchronized");
      NodeAssert.equal(yield* Effect.promise(() => NodeFSP.readFile(configPath, "utf8")), original);
      NodeAssert.equal(JSON.stringify(adopted).includes("secret-value"), false);
      const duplicate = yield* Effect.flip(service.adopt(input));
      NodeAssert.equal(duplicate._tag, "HarnessError");

      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          configPath,
          JSON.stringify({ mcpServers: { gitlab: { command: "node", args: ["changed.js"] } } }),
        ),
      );
      NodeAssert.equal((yield* service.list())[0]?.drift, "drifted");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(configPath, JSON.stringify({ mcpServers: {} })),
      );
      NodeAssert.equal((yield* service.list())[0]?.drift, "missing");
      NodeAssert.equal(yield* service.untrack(adopted.id), true);
      NodeAssert.deepEqual(yield* service.list(), []);
    }).pipe(
      Effect.provide(
        serviceLayer(NodePath.join(directory, "home"), NodePath.join(directory, "project")),
      ),
      Effect.ensuring(
        Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
      ),
    );
  }),
);

it.effect("verifies applied fingerprints and recovers a write after a process interruption", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "harness-mcp-recovery-")),
    );
    return yield* Effect.gen(function* () {
      const home = NodePath.join(directory, "home");
      const project = NodePath.join(directory, "project");
      const configPath = NodePath.join(project, ".mcp.json");
      yield* Effect.promise(() => NodeFSP.mkdir(home));
      yield* Effect.promise(() => NodeFSP.mkdir(project));
      const firstContents = JSON.stringify({
        mcpServers: { gitlab: { command: "node", args: [] } },
      });
      yield* Effect.promise(() => NodeFSP.writeFile(configPath, firstContents));
      const service = yield* initialize;
      const actual = discoverNativeMcp("claude", firstContents);
      if (!("servers" in actual)) throw new Error("Expected supported MCP configuration.");
      const expectedFingerprint = actual.servers[0]!.fingerprint;
      const mismatch = yield* Effect.flip(
        service.recordApplied({ ...input, configurationFingerprint: "a".repeat(64) }),
      );
      NodeAssert.equal(mismatch._tag, "HarnessError");
      NodeAssert.deepEqual(yield* service.list(), []);

      yield* service.beginApply({ ...input, expectedFingerprint });
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          configPath,
          JSON.stringify({ mcpServers: { gitlab: { command: "node", args: [] } } }, null, 2),
        ),
      );
      const recovered = yield* service.list();
      NodeAssert.equal(recovered.length, 1);
      NodeAssert.equal(recovered[0]?.trackingOrigin, "applied");
      NodeAssert.equal(recovered[0]?.drift, "synchronized");
      NodeAssert.equal(recovered[0]?.configurationFingerprint, expectedFingerprint);
    }).pipe(
      Effect.provide(
        serviceLayer(NodePath.join(directory, "home"), NodePath.join(directory, "project")),
      ),
      Effect.ensuring(
        Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
      ),
    );
  }),
);
