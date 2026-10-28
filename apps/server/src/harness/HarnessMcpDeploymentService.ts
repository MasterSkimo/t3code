// @effect-diagnostics nodeBuiltinImport:off -- native MCP configuration files are inspected without following links.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { HarnessError, ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ProjectService from "../project/ProjectService.ts";
import { discoverNativeMcp, type HubMcpProvider } from "./hubMcp.ts";

const MAX_CONFIG_BYTES = 1_000_000;

export type HarnessMcpDeploymentInput = {
  readonly sourceResourceId: string;
  readonly sourceScope: "project" | "global";
  readonly sourceProjectId?: string;
  readonly targetProvider: Exclude<HubMcpProvider, "codex">;
  readonly targetScope: "project" | "global";
  readonly targetProjectId?: string;
  readonly serverName: string;
};

export type HarnessMcpDeployment = HarnessMcpDeploymentInput & {
  readonly id: string;
  readonly configurationFingerprint: string;
  readonly trackingOrigin: "adopted" | "applied";
  readonly trackedAt: string;
  readonly updatedAt: string;
  readonly drift: "synchronized" | "drifted" | "missing" | "unknown";
};

type DeploymentRow = {
  readonly deployment_id: string;
  readonly source_resource_id: string;
  readonly source_scope: "project" | "global";
  readonly source_project_id: string;
  readonly target_provider: Exclude<HubMcpProvider, "codex">;
  readonly target_scope: "project" | "global";
  readonly target_project_id: string;
  readonly server_name: string;
  readonly configuration_fingerprint: string;
  readonly tracking_origin: "adopted" | "applied";
  readonly pending_fingerprint: string | null;
  readonly pending_is_new: number;
  readonly tracked_at: string;
  readonly updated_at: string;
};

export class HarnessMcpDeploymentService extends Context.Service<
  HarnessMcpDeploymentService,
  {
    /** Records a deployment only after verifying the applied fingerprint against the live native entry. */
    readonly recordApplied: (
      input: HarnessMcpDeploymentInput & { readonly configurationFingerprint: string },
    ) => Effect.Effect<HarnessMcpDeployment, HarnessError>;
    /** Persists an apply intent before the native file write so list() can recover a crash. */
    readonly beginApply: (
      input: HarnessMcpDeploymentInput & { readonly expectedFingerprint: string },
    ) => Effect.Effect<void, HarnessError>;
    /** Adopts a live native entry for drift tracking; never modifies provider configuration. */
    readonly adopt: (
      input: HarnessMcpDeploymentInput,
    ) => Effect.Effect<HarnessMcpDeployment, HarnessError>;
    readonly list: () => Effect.Effect<ReadonlyArray<HarnessMcpDeployment>, HarnessError>;
    readonly untrack: (deploymentId: string) => Effect.Effect<boolean, HarnessError>;
  }
>()("t3/harness/HarnessMcpDeploymentService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const home = yield* HostProcess.HomeDirectory;
  const projects = yield* ProjectService.ProjectService;
  const fail = (message: string) => new HarnessError({ message });
  const now = () => Effect.map(DateTime.now, (date) => DateTime.formatIso(DateTime.toUtc(date)));

  const validateInput = (input: HarnessMcpDeploymentInput) => {
    if (!/^mcp:[a-f0-9]{24}$/.test(input.sourceResourceId))
      return "MCP source resource id is invalid.";
    if (!input.serverName.trim() || input.serverName.length > 200)
      return "MCP server name is invalid.";
    if (input.sourceScope === "project" && !input.sourceProjectId?.trim())
      return "Project source scope requires a project id.";
    if (input.targetScope === "project" && !input.targetProjectId?.trim())
      return "Project target scope requires a project id.";
    return undefined;
  };

  const resolveRoot = Effect.fn("HarnessMcpDeploymentService.resolveRoot")(function* (
    scope: "project" | "global",
    projectId: string | undefined,
  ) {
    if (scope === "global") return home;
    if (!projectId) return yield* fail("Project scope requires a project id.");
    const result = yield* projects
      .getById(ProjectId.make(projectId))
      .pipe(Effect.mapError(() => fail("Could not resolve the selected project.")));
    const project = Option.getOrUndefined(result);
    if (!project) return yield* fail("The selected project was not found.");
    return project.workspaceRoot;
  });

  const targetPath = (input: HarnessMcpDeploymentInput, root: string): string => {
    if (input.targetProvider === "claude")
      return NodePath.join(root, input.targetScope === "project" ? ".mcp.json" : ".claude.json");
    return input.targetScope === "project"
      ? NodePath.join(root, "opencode.json")
      : NodePath.join(home, ".config", "opencode", "opencode.json");
  };

  const readTargetFingerprint = Effect.fn("HarnessMcpDeploymentService.readTargetFingerprint")(
    function* (input: HarnessMcpDeploymentInput) {
      const root = yield* resolveRoot(input.targetScope, input.targetProjectId);
      const path = targetPath(input, root);
      if (input.targetProvider === "opencode" && input.targetScope === "project") {
        const jsonc = yield* Effect.tryPromise({
          try: () =>
            NodeFSP.lstat(NodePath.join(root, "opencode.jsonc")).then(
              () => true,
              (error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return false;
                throw error;
              },
            ),
          catch: () => fail("Could not inspect OpenCode project configuration."),
        });
        if (jsonc) return { kind: "unknown" as const };
      }
      const contents = yield* Effect.tryPromise({
        try: async () => {
          try {
            const stat = await NodeFSP.lstat(path);
            if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_CONFIG_BYTES)
              throw new Error("Unsupported MCP configuration file.");
            return await NodeFSP.readFile(path, "utf8");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw error;
          }
        },
        catch: () => fail("Could not safely inspect the native MCP configuration."),
      });
      if (contents === null) return { kind: "missing" as const };
      const native = discoverNativeMcp(input.targetProvider, contents);
      if (!("servers" in native)) return { kind: "unknown" as const };
      const entry = native.servers.find((server) => server.name === input.serverName);
      return entry === undefined
        ? { kind: "missing" as const }
        : { kind: "present" as const, fingerprint: entry.fingerprint };
    },
  );

  const toInput = (row: DeploymentRow): HarnessMcpDeploymentInput => ({
    sourceResourceId: row.source_resource_id,
    sourceScope: row.source_scope,
    ...(row.source_project_id === "" ? {} : { sourceProjectId: row.source_project_id }),
    targetProvider: row.target_provider,
    targetScope: row.target_scope,
    ...(row.target_project_id === "" ? {} : { targetProjectId: row.target_project_id }),
    serverName: row.server_name,
  });

  const currentDrift = (
    row: DeploymentRow,
  ): Effect.Effect<HarnessMcpDeployment["drift"], HarnessError> =>
    readTargetFingerprint(toInput(row)).pipe(
      Effect.map((result) => {
        if (result.kind === "unknown") return "unknown" as const;
        if (result.kind === "missing") return "missing" as const;
        return result.fingerprint === row.configuration_fingerprint
          ? ("synchronized" as const)
          : ("drifted" as const);
      }),
    );

  const resultForRow = (row: DeploymentRow) =>
    currentDrift(row).pipe(
      Effect.map((drift): HarnessMcpDeployment => ({
        ...toInput(row),
        id: row.deployment_id,
        configurationFingerprint: row.configuration_fingerprint,
        trackingOrigin: row.tracking_origin,
        trackedAt: row.tracked_at,
        updatedAt: row.updated_at,
        drift,
      })),
    );

  const recordApplied: HarnessMcpDeploymentService["Service"]["recordApplied"] = Effect.fn(
    "HarnessMcpDeploymentService.recordApplied",
  )(function* (input) {
    const validationError = validateInput(input);
    if (validationError) return yield* fail(validationError);
    if (!/^[a-f0-9]{64}$/.test(input.configurationFingerprint))
      return yield* fail("Applied MCP configuration fingerprint is invalid.");
    const current = yield* readTargetFingerprint(input);
    if (current.kind !== "present" || current.fingerprint !== input.configurationFingerprint)
      return yield* fail("Applied MCP entry changed before deployment tracking could be saved.");

    const at = yield* now();
    const id = NodeCrypto.randomUUID();
    const rows = yield* sql<DeploymentRow>`
      INSERT INTO harness_mcp_deployments (
        deployment_id, source_resource_id, source_scope, source_project_id,
        target_provider, target_scope, target_project_id, server_name,
        configuration_fingerprint, tracking_origin, pending_fingerprint,
        pending_is_new, tracked_at, updated_at
      ) VALUES (
        ${id}, ${input.sourceResourceId}, ${input.sourceScope}, ${input.sourceProjectId ?? ""},
        ${input.targetProvider}, ${input.targetScope}, ${input.targetProjectId ?? ""}, ${input.serverName},
        ${input.configurationFingerprint}, 'applied', NULL, 0, ${at}, ${at}
      ) ON CONFLICT (target_provider, target_scope, target_project_id, server_name)
      DO UPDATE SET
        source_resource_id = excluded.source_resource_id,
        source_scope = excluded.source_scope,
        source_project_id = excluded.source_project_id,
        configuration_fingerprint = excluded.configuration_fingerprint,
        tracking_origin = 'applied',
        pending_fingerprint = NULL,
        pending_is_new = 0,
        updated_at = excluded.updated_at
      WHERE harness_mcp_deployments.source_resource_id = excluded.source_resource_id
      RETURNING *
    `.pipe(Effect.mapError(() => fail("Could not record the MCP deployment.")));
    const row = rows[0];
    if (!row) return yield* fail("This native MCP entry is already tracked from another source.");
    return yield* resultForRow(row);
  });

  const beginApply: HarnessMcpDeploymentService["Service"]["beginApply"] = Effect.fn(
    "HarnessMcpDeploymentService.beginApply",
  )(function* (input) {
    const validationError = validateInput(input);
    if (validationError) return yield* fail(validationError);
    if (!/^[a-f0-9]{64}$/.test(input.expectedFingerprint))
      return yield* fail("Expected MCP configuration fingerprint is invalid.");
    const at = yield* now();
    const rows = yield* sql<DeploymentRow>`
      INSERT INTO harness_mcp_deployments (
        deployment_id, source_resource_id, source_scope, source_project_id,
        target_provider, target_scope, target_project_id, server_name,
        configuration_fingerprint, tracking_origin, pending_fingerprint,
        pending_is_new, tracked_at, updated_at
      ) VALUES (
        ${NodeCrypto.randomUUID()}, ${input.sourceResourceId}, ${input.sourceScope}, ${input.sourceProjectId ?? ""},
        ${input.targetProvider}, ${input.targetScope}, ${input.targetProjectId ?? ""}, ${input.serverName},
        ${input.expectedFingerprint}, 'applied', ${input.expectedFingerprint}, 1, ${at}, ${at}
      ) ON CONFLICT (target_provider, target_scope, target_project_id, server_name)
      DO UPDATE SET
        pending_fingerprint = excluded.pending_fingerprint,
        pending_is_new = 0,
        updated_at = excluded.updated_at
      WHERE harness_mcp_deployments.source_resource_id = excluded.source_resource_id
      RETURNING deployment_id
    `.pipe(Effect.mapError(() => fail("Could not prepare MCP deployment tracking.")));
    if (!rows[0]) return yield* fail("This native MCP entry is tracked from another source.");
  });

  const adopt: HarnessMcpDeploymentService["Service"]["adopt"] = Effect.fn(
    "HarnessMcpDeploymentService.adopt",
  )(function* (input) {
    const validationError = validateInput(input);
    if (validationError) return yield* fail(validationError);
    const current = yield* readTargetFingerprint(input);
    if (current.kind !== "present")
      return yield* fail("Only a readable existing native MCP entry can be adopted.");
    const at = yield* now();
    const rows = yield* sql<DeploymentRow>`
      INSERT INTO harness_mcp_deployments (
        deployment_id, source_resource_id, source_scope, source_project_id,
        target_provider, target_scope, target_project_id, server_name,
        configuration_fingerprint, tracking_origin, tracked_at, updated_at
      ) VALUES (
        ${NodeCrypto.randomUUID()}, ${input.sourceResourceId}, ${input.sourceScope}, ${input.sourceProjectId ?? ""},
        ${input.targetProvider}, ${input.targetScope}, ${input.targetProjectId ?? ""}, ${input.serverName},
        ${current.fingerprint}, 'adopted', ${at}, ${at}
      ) ON CONFLICT (target_provider, target_scope, target_project_id, server_name) DO NOTHING
      RETURNING *
    `.pipe(Effect.mapError(() => fail("Could not adopt the MCP deployment.")));
    const row = rows[0];
    if (!row)
      return yield* fail(
        "This native MCP entry is already tracked; adoption will not replace its tracking.",
      );
    return yield* resultForRow(row);
  });

  const list: HarnessMcpDeploymentService["Service"]["list"] = Effect.fn(
    "HarnessMcpDeploymentService.list",
  )(function* () {
    const pendingRows = yield* sql<DeploymentRow>`
      SELECT * FROM harness_mcp_deployments ORDER BY updated_at DESC, deployment_id ASC
    `.pipe(Effect.mapError(() => fail("Could not list tracked MCP deployments.")));
    for (const row of pendingRows) {
      if (row.pending_fingerprint === null) continue;
      const current = yield* readTargetFingerprint(toInput(row));
      if (current.kind === "present" && current.fingerprint === row.pending_fingerprint) {
        const at = yield* now();
        yield* sql`
          UPDATE harness_mcp_deployments
          SET configuration_fingerprint = ${row.pending_fingerprint}, tracking_origin = 'applied',
              pending_fingerprint = NULL, pending_is_new = 0, updated_at = ${at}
          WHERE deployment_id = ${row.deployment_id} AND pending_fingerprint = ${row.pending_fingerprint}
        `.pipe(Effect.mapError(() => fail("Could not recover MCP deployment tracking.")));
      } else if (row.pending_is_new === 1) {
        yield* sql`
          DELETE FROM harness_mcp_deployments
          WHERE deployment_id = ${row.deployment_id} AND pending_fingerprint = ${row.pending_fingerprint}
        `.pipe(Effect.mapError(() => fail("Could not clear interrupted MCP deployment tracking.")));
      } else {
        yield* sql`
          UPDATE harness_mcp_deployments SET pending_fingerprint = NULL, pending_is_new = 0
          WHERE deployment_id = ${row.deployment_id} AND pending_fingerprint = ${row.pending_fingerprint}
        `.pipe(Effect.mapError(() => fail("Could not clear interrupted MCP deployment tracking.")));
      }
    }
    const rows = yield* sql<DeploymentRow>`
      SELECT * FROM harness_mcp_deployments ORDER BY updated_at DESC, deployment_id ASC
    `.pipe(Effect.mapError(() => fail("Could not list tracked MCP deployments.")));
    return yield* Effect.forEach(rows, resultForRow);
  });

  const untrack: HarnessMcpDeploymentService["Service"]["untrack"] = Effect.fn(
    "HarnessMcpDeploymentService.untrack",
  )(function* (deploymentId) {
    const rows = yield* sql`
      DELETE FROM harness_mcp_deployments WHERE deployment_id = ${deploymentId} RETURNING deployment_id
    `.pipe(Effect.mapError(() => fail("Could not remove MCP deployment tracking.")));
    return rows.length > 0;
  });

  return HarnessMcpDeploymentService.of({ recordApplied, beginApply, adopt, list, untrack });
});

export const layer = Layer.effect(HarnessMcpDeploymentService, make);
