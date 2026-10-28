// @effect-diagnostics nodeBuiltinImport:off -- provider-native MCP config files are resolved and guarded on the server.
// @effect-diagnostics preferSchemaOverJson:off -- provider-native JSON is preserved in its original schema.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  HarnessError,
  ProjectId,
  type HarnessMcpDistributionApplyInput,
  type HarnessMcpDistributionApplyResult,
  type HarnessMcpDistributionPreviewInput,
  type HarnessMcpDistributionPreviewResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ProjectService from "../project/ProjectService.ts";
import * as HarnessMcpDeployment from "./HarnessMcpDeploymentService.ts";
import type { HarnessMcpDeployment as Deployment } from "./HarnessMcpDeploymentService.ts";
import {
  applyNativeMcpWrite,
  discoverNativeMcp,
  hubMcpFingerprint,
  planNativeMcpWrite,
  type HubMcpProvider,
  type PortableMcpServer,
} from "./hubMcp.ts";

const MAX_CONFIG_BYTES = 1_000_000;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

type SourceCandidate = { readonly provider: "claude" | "opencode"; readonly filePath: string };
type ResolvedSource = SourceCandidate & {
  readonly name: string;
  readonly fileFingerprint: string;
  readonly entryFingerprint: string;
  readonly configuration: unknown;
  readonly portable: PortableMcpServer;
};

const resourceId = (filePath: string, name: string): string =>
  `mcp:${NodeCrypto.createHash("sha256")
    .update(`${NodePath.resolve(filePath)}\0${name}`)
    .digest("hex")
    .slice(0, 24)}`;

const sourceCandidates = (
  scope: "project" | "global",
  root: string,
): ReadonlyArray<SourceCandidate> =>
  scope === "project"
    ? [
        { provider: "claude", filePath: NodePath.join(root, ".mcp.json") },
        { provider: "claude", filePath: NodePath.join(root, ".claude", "settings.json") },
        { provider: "opencode", filePath: NodePath.join(root, "opencode.json") },
      ]
    : [
        { provider: "claude", filePath: NodePath.join(root, ".claude.json") },
        {
          provider: "opencode",
          filePath: NodePath.join(root, ".config", "opencode", "opencode.json"),
        },
      ];

const serverMap = (
  provider: "claude" | "opencode",
  document: Record<string, unknown>,
): Record<string, unknown> | undefined => {
  if (provider === "claude") return isRecord(document.mcpServers) ? document.mcpServers : undefined;
  const mcp = document.mcp;
  if (!isRecord(mcp)) return undefined;
  if (mcp.servers !== undefined) return isRecord(mcp.servers) ? mcp.servers : undefined;
  if (
    Object.keys(mcp).length === 0 ||
    !Object.values(mcp).every(
      (entry) => isRecord(entry) && (entry.type === "local" || entry.type === "remote"),
    )
  ) {
    return undefined;
  }
  return mcp;
};

const readConfig = async (filePath: string): Promise<string | null> => {
  try {
    const stat = await NodeFSP.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_CONFIG_BYTES) {
      throw new Error("Unsupported configuration file.");
    }
    return await NodeFSP.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

const normalizedSource = (
  provider: "claude" | "opencode",
  configuration: unknown,
): PortableMcpServer | undefined => {
  if (!isRecord(configuration)) return undefined;
  const keys = Object.keys(configuration);
  if (provider === "claude") {
    if (
      typeof configuration.command === "string" &&
      (configuration.args === undefined ||
        (Array.isArray(configuration.args) &&
          configuration.args.every((arg) => typeof arg === "string"))) &&
      keys.every((key) => key === "command" || key === "args")
    ) {
      return {
        transport: "stdio",
        command: configuration.command,
        args: (configuration.args as ReadonlyArray<string> | undefined) ?? [],
      };
    }
    if (
      configuration.type === "http" &&
      typeof configuration.url === "string" &&
      keys.every((key) => key === "type" || key === "url")
    ) {
      return { transport: "http", url: configuration.url };
    }
    return undefined;
  }
  if (
    configuration.type === "local" &&
    Array.isArray(configuration.command) &&
    configuration.command.length > 0 &&
    configuration.command.every((arg) => typeof arg === "string") &&
    keys.every((key) => key === "type" || key === "command")
  ) {
    const [command, ...args] = configuration.command as [string, ...string[]];
    return { transport: "stdio", command, args };
  }
  if (
    configuration.type === "remote" &&
    typeof configuration.url === "string" &&
    keys.every((key) => key === "type" || key === "url")
  ) {
    return { transport: "http", url: configuration.url };
  }
  return undefined;
};

const resolveSource = async (
  sourceResourceId: string,
  scope: "project" | "global",
  root: string,
): Promise<ResolvedSource | undefined> => {
  for (const candidate of sourceCandidates(scope, root)) {
    const contents = await readConfig(candidate.filePath);
    if (contents === null) continue;
    let document: unknown;
    try {
      document = JSON.parse(contents) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(document)) continue;
    const servers = serverMap(candidate.provider, document);
    if (!servers) continue;
    for (const [name, configuration] of Object.entries(servers)) {
      if (resourceId(candidate.filePath, name) !== sourceResourceId) continue;
      const portable = normalizedSource(candidate.provider, configuration);
      if (!portable) return undefined;
      return {
        ...candidate,
        name,
        fileFingerprint: hubMcpFingerprint(contents),
        entryFingerprint: hubMcpFingerprint(configuration),
        configuration,
        portable,
      };
    }
  }
  return undefined;
};

export class HarnessMcpService extends Context.Service<
  HarnessMcpService,
  {
    readonly preview: (
      input: HarnessMcpDistributionPreviewInput,
    ) => Effect.Effect<HarnessMcpDistributionPreviewResult, HarnessError>;
    readonly apply: (
      input: HarnessMcpDistributionApplyInput,
    ) => Effect.Effect<HarnessMcpDistributionApplyResult, HarnessError>;
    readonly adopt: (
      input: HarnessMcpDistributionPreviewInput,
    ) => Effect.Effect<Deployment, HarnessError>;
    readonly listDeployments: () => Effect.Effect<ReadonlyArray<Deployment>, HarnessError>;
    readonly untrackDeployment: (id: string) => Effect.Effect<boolean, HarnessError>;
  }
>()("t3/harness/HarnessMcpService") {}

const make = Effect.gen(function* () {
  const home = yield* HostProcess.HomeDirectory;
  const projects = yield* ProjectService.ProjectService;
  const deployments = yield* HarnessMcpDeployment.HarnessMcpDeploymentService;
  const previews = new Map<
    string,
    {
      readonly token: string;
      readonly input: HarnessMcpDistributionPreviewInput;
      readonly source: ResolvedSource;
      readonly targetPath: string;
      readonly targetFileFingerprint: string;
      readonly expectedEntryFingerprint: string;
    }
  >();
  const fail = (message: string) => new HarnessError({ message });

  const resolveRoot = Effect.fn("HarnessMcpService.resolveRoot")(function* (
    scope: "project" | "global",
    projectId: string | undefined,
  ) {
    if (scope === "global") return home;
    if (!projectId) return yield* fail("Project scope requires a project id.");
    const project = yield* projects
      .getById(ProjectId.make(projectId))
      .pipe(Effect.mapError(() => fail("Could not resolve the selected project.")));
    const found = Option.getOrUndefined(project);
    if (!found) return yield* fail("The selected project was not found.");
    return found.workspaceRoot;
  });

  const resolveTargetPath = (
    provider: HubMcpProvider,
    scope: "project" | "global",
    root: string,
  ): string | undefined => {
    if (provider === "codex") return undefined;
    if (provider === "claude") {
      return NodePath.join(root, scope === "project" ? ".mcp.json" : ".claude.json");
    }
    const filePath =
      scope === "project"
        ? NodePath.join(root, "opencode.json")
        : NodePath.join(home, ".config", "opencode", "opencode.json");
    return filePath;
  };

  const preview: HarnessMcpService["Service"]["preview"] = Effect.fn("HarnessMcpService.preview")(
    function* (input) {
      if (input.targetProvider === "codex") {
        return {
          status: "unsupported",
          targetProvider: "codex",
          targetScope: input.targetScope,
          before: null,
          after: null,
          connectionStatus: "unknown",
          reason:
            "Codex TOML distribution is unsupported until a safe native TOML adapter is available.",
        };
      }
      const sourceRoot = yield* resolveRoot(input.sourceScope, input.sourceProjectId);
      const source = yield* Effect.tryPromise({
        try: () => resolveSource(input.sourceResourceId, input.sourceScope, sourceRoot),
        catch: () => fail("Could not safely read the source MCP configuration."),
      });
      if (!source) {
        return {
          status: "unsupported",
          targetProvider: input.targetProvider,
          targetScope: input.targetScope,
          before: null,
          after: null,
          connectionStatus: "unknown",
          reason: "The selected native MCP resource is unavailable or uses unsupported fields.",
        };
      }
      const targetRoot = yield* resolveRoot(input.targetScope, input.targetProjectId);
      const targetPath = resolveTargetPath(input.targetProvider, input.targetScope, targetRoot);
      if (!targetPath) {
        return {
          status: "unsupported",
          sourceName: source.name,
          sourceProvider: source.provider,
          targetProvider: input.targetProvider,
          targetScope: input.targetScope,
          before: null,
          after: null,
          connectionStatus: "unknown",
          reason: "Target provider is unsupported.",
        };
      }
      if (input.targetProvider === "opencode" && input.targetScope === "project") {
        const jsoncExists = yield* Effect.tryPromise({
          try: () =>
            NodeFSP.lstat(NodePath.join(targetRoot, "opencode.jsonc")).then(
              () => true,
              () => false,
            ),
          catch: () => fail("Could not inspect OpenCode project configuration."),
        });
        if (jsoncExists) {
          return {
            status: "unsupported",
            sourceName: source.name,
            sourceProvider: source.provider,
            targetProvider: input.targetProvider,
            targetScope: input.targetScope,
            before: null,
            after: null,
            connectionStatus: "unknown",
            reason: "OpenCode JSONC configuration is not rewritten by the safe adapter.",
          };
        }
      }
      const targetContents = yield* Effect.tryPromise({
        try: () => readConfig(targetPath),
        catch: () => fail("Could not safely read the target MCP configuration."),
      });
      const targetFileFingerprint =
        targetContents === null ? "missing" : hubMcpFingerprint(targetContents);
      const plan = planNativeMcpWrite({
        provider: input.targetProvider,
        contents: targetContents,
        expectedFileFingerprint: targetFileFingerprint,
        name: source.name,
        server: source.portable,
      });
      const beforeDiscovery =
        targetContents === null
          ? undefined
          : discoverNativeMcp(input.targetProvider, targetContents);
      const beforePresent =
        beforeDiscovery !== undefined &&
        "servers" in beforeDiscovery &&
        beforeDiscovery.servers.some((server) => server.name === source.name);
      const before = beforePresent
        ? "Existing native MCP entry (configuration values hidden)."
        : null;
      const after =
        source.portable.transport === "stdio"
          ? "stdio server configuration (command and arguments hidden)."
          : "HTTP server configuration (endpoint hidden).";
      if (plan.status === "unsupported" || plan.status === "conflict") {
        return {
          status: plan.status,
          sourceName: source.name,
          sourceProvider: source.provider,
          targetProvider: input.targetProvider,
          targetScope: input.targetScope,
          before,
          after,
          connectionStatus: "unknown",
          reason: plan.reason,
        };
      }
      if (plan.status === "unchanged") {
        return {
          status: "unchanged",
          sourceName: source.name,
          sourceProvider: source.provider,
          targetProvider: input.targetProvider,
          targetScope: input.targetScope,
          before,
          after,
          connectionStatus: "unknown",
        };
      }
      const plannedTarget = discoverNativeMcp(input.targetProvider, plan.contents);
      const plannedEntry =
        "servers" in plannedTarget
          ? plannedTarget.servers.find((server) => server.name === source.name)
          : undefined;
      if (!plannedEntry) {
        return {
          status: "unsupported",
          sourceName: source.name,
          sourceProvider: source.provider,
          targetProvider: input.targetProvider,
          targetScope: input.targetScope,
          before,
          after,
          connectionStatus: "unknown",
          reason: "The planned MCP entry could not be safely verified.",
        };
      }
      const previewId = NodeCrypto.randomUUID();
      const confirmationToken = NodeCrypto.randomUUID();
      previews.set(previewId, {
        token: confirmationToken,
        input,
        source,
        targetPath,
        targetFileFingerprint,
        expectedEntryFingerprint: plannedEntry.fingerprint,
      });
      if (previews.size > 100) previews.delete(previews.keys().next().value!);
      return {
        status: "ready",
        previewId,
        confirmationToken,
        sourceName: source.name,
        sourceProvider: source.provider,
        targetProvider: input.targetProvider,
        targetScope: input.targetScope,
        before,
        after,
        connectionStatus: "unknown",
      };
    },
  );

  const apply: HarnessMcpService["Service"]["apply"] = Effect.fn("HarnessMcpService.apply")(
    function* (input) {
      if (!input.confirmed)
        return yield* fail("Explicit confirmation is required to distribute an MCP.");
      const stored = previews.get(input.previewId);
      if (!stored || stored.token !== input.confirmationToken) {
        return yield* fail("MCP distribution preview expired; prepare a new preview.");
      }
      const sourceRoot = yield* resolveRoot(stored.input.sourceScope, stored.input.sourceProjectId);
      const latestSource = yield* Effect.tryPromise({
        try: () =>
          resolveSource(stored.input.sourceResourceId, stored.input.sourceScope, sourceRoot),
        catch: () => fail("Could not verify the source MCP configuration."),
      });
      if (
        !latestSource ||
        latestSource.fileFingerprint !== stored.source.fileFingerprint ||
        latestSource.entryFingerprint !== stored.source.entryFingerprint
      ) {
        return {
          status: "conflict",
          name: stored.source.name,
          provider: stored.input.targetProvider,
          scope: stored.input.targetScope,
          connectionStatus: "unknown",
          reason: "Source MCP configuration changed since the preview was created.",
        };
      }
      const targetRoot = yield* resolveRoot(stored.input.targetScope, stored.input.targetProjectId);
      const currentTargetPath = resolveTargetPath(
        stored.input.targetProvider,
        stored.input.targetScope,
        targetRoot,
      );
      if (currentTargetPath !== stored.targetPath) {
        return yield* fail("Target scope changed; prepare a new preview.");
      }
      if (stored.input.targetProvider === "codex") {
        return yield* fail("Codex MCP deployment tracking is unsupported.");
      }
      const deploymentInput = {
        sourceResourceId: stored.input.sourceResourceId,
        sourceScope: stored.input.sourceScope,
        ...(stored.input.sourceProjectId === undefined
          ? {}
          : { sourceProjectId: stored.input.sourceProjectId }),
        targetProvider: stored.input.targetProvider,
        targetScope: stored.input.targetScope,
        ...(stored.input.targetProjectId === undefined
          ? {}
          : { targetProjectId: stored.input.targetProjectId }),
        serverName: stored.source.name,
      } as const;
      yield* deployments.beginApply({
        ...deploymentInput,
        expectedFingerprint: stored.expectedEntryFingerprint,
      });
      const result = yield* Effect.tryPromise({
        try: () =>
          applyNativeMcpWrite({
            filePath: stored.targetPath,
            provider: stored.input.targetProvider,
            expectedFileFingerprint: stored.targetFileFingerprint,
            name: stored.source.name,
            server: stored.source.portable,
          }),
        catch: () => fail("Could not safely apply the native MCP configuration."),
      });
      if (result.status === "conflict" || result.status === "unsupported") {
        return {
          status: result.status,
          name: stored.source.name,
          provider: stored.input.targetProvider,
          scope: stored.input.targetScope,
          connectionStatus: "unknown",
          reason: result.reason,
        };
      }
      previews.delete(input.previewId);
      const after = discoverNativeMcp(stored.input.targetProvider, result.contents);
      const entry =
        "servers" in after
          ? after.servers.find((server) => server.name === stored.source.name)
          : undefined;
      if (entry === undefined)
        return yield* fail(
          "Applied native MCP entry could not be verified for deployment tracking.",
        );
      yield* deployments.recordApplied({
        ...deploymentInput,
        configurationFingerprint: entry.fingerprint,
      });
      return {
        status: result.status === "unchanged" ? "unchanged" : "distributed",
        name: stored.source.name,
        provider: stored.input.targetProvider,
        scope: stored.input.targetScope,
        configurationFingerprint: entry.fingerprint,
        connectionStatus: "unknown",
      };
    },
  );

  const adopt: HarnessMcpService["Service"]["adopt"] = Effect.fn("HarnessMcpService.adopt")(
    function* (input) {
      if (input.targetProvider === "codex")
        return yield* fail("Codex MCP deployment tracking is unsupported.");
      const sourceRoot = yield* resolveRoot(input.sourceScope, input.sourceProjectId);
      const source = yield* Effect.tryPromise({
        try: () => resolveSource(input.sourceResourceId, input.sourceScope, sourceRoot),
        catch: () => fail("Could not safely resolve the source MCP configuration."),
      });
      if (!source)
        return yield* fail("The selected source MCP resource is unavailable or unsupported.");
      const targetRoot = yield* resolveRoot(input.targetScope, input.targetProjectId);
      const targetPath = resolveTargetPath(input.targetProvider, input.targetScope, targetRoot);
      if (!targetPath) return yield* fail("Target provider is unsupported.");
      return yield* deployments.adopt({
        sourceResourceId: input.sourceResourceId,
        sourceScope: input.sourceScope,
        ...(input.sourceProjectId === undefined ? {} : { sourceProjectId: input.sourceProjectId }),
        targetProvider: input.targetProvider,
        targetScope: input.targetScope,
        ...(input.targetProjectId === undefined ? {} : { targetProjectId: input.targetProjectId }),
        serverName: source.name,
      });
    },
  );

  const listDeployments: HarnessMcpService["Service"]["listDeployments"] = () => deployments.list();
  const untrackDeployment: HarnessMcpService["Service"]["untrackDeployment"] = (id) =>
    deployments.untrack(id);

  return HarnessMcpService.of({ preview, apply, adopt, listDeployments, untrackDeployment });
});

export const layer = Layer.effect(HarnessMcpService, make);
