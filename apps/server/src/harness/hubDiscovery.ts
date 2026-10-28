// @effect-diagnostics nodeBuiltinImport:off -- discovery reads local agent configuration using Node filesystem primitives.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { discoverSkills } from "./skills.ts";

const fs = NodeFS.promises;
const path = NodePath;
const MAX_FILE_BYTES = 1_000_000;
const MAX_ENTRIES_PER_DIRECTORY = 500;

export type HarnessHubType = "skill" | "rule" | "agent" | "hook" | "mcp" | "unknown";
export type HarnessHubScope = "project" | "global";

/** A safe inventory descriptor. It deliberately carries no file contents or absolute paths. */
export interface HarnessHubDescriptor {
  readonly id: string;
  readonly type: HarnessHubType;
  readonly name: string;
  readonly scope: HarnessHubScope;
  readonly projectId?: string;
  readonly provider?: string;
  readonly source: string;
  readonly ownership: "managed" | "user" | "unknown";
  readonly description?: string;
  readonly status: "installed" | "unknown";
  readonly operations: readonly string[];
}

export interface HarnessHubDiscoveryInput {
  readonly workspaceRoot: string;
  readonly homeDirectory: string;
  readonly projectId?: string;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const safeName = (value: string) => value.replace(/[\r\n\0]/g, " ").slice(0, 120);
const hasSecretName = (value: string) =>
  /(?:secret|token|password|credential|private.?key|api.?key|auth)/i.test(value);
const idFor = (type: HarnessHubType, absoluteSource: string, name: string) =>
  `${type}:${NodeCrypto.createHash("sha256")
    .update(`${path.resolve(absoluteSource)}\0${name}`)
    .digest("hex")
    .slice(0, 24)}`;

function descriptor(
  input: HarnessHubDiscoveryInput,
  args: {
    type: HarnessHubType;
    name: string;
    scope: HarnessHubScope;
    absoluteSource: string;
    source: string;
    provider?: string;
    ownership?: HarnessHubDescriptor["ownership"];
    status?: HarnessHubDescriptor["status"];
    description?: string;
  },
): HarnessHubDescriptor {
  return {
    id: idFor(args.type, args.absoluteSource, args.name),
    type: args.type,
    name: safeName(args.name),
    scope: args.scope,
    ...(input.projectId === undefined || args.scope !== "project"
      ? {}
      : { projectId: input.projectId }),
    ...(args.provider === undefined ? {} : { provider: args.provider }),
    source: args.source,
    ownership: args.ownership ?? "user",
    ...(args.description === undefined ? {} : { description: safeName(args.description) }),
    status: args.status ?? "installed",
    operations: [],
  };
}

async function lstatFile(file: string) {
  try {
    const stat = await fs.lstat(file);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_FILE_BYTES;
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

async function isRealDirectory(directory: string) {
  try {
    const stat = await fs.lstat(directory);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

async function readJson(file: string): Promise<{ value?: unknown; problem?: string }> {
  if (!(await lstatFile(file))) return {};
  try {
    return { value: JSON.parse(await fs.readFile(file, "utf8")) as unknown };
  } catch {
    return { problem: "Configuration could not be parsed." };
  }
}

async function filesUnder(root: string, suffix?: string): Promise<string[]> {
  if (
    !(await fs
      .lstat(root)
      .then((s) => s.isDirectory() && !s.isSymbolicLink())
      .catch(() => false))
  )
    return [];
  const found: string[] = [];
  const queue = [root];
  let visited = 0;
  while (
    queue.length &&
    found.length < MAX_ENTRIES_PER_DIRECTORY &&
    visited < MAX_ENTRIES_PER_DIRECTORY
  ) {
    const directory = queue.shift()!;
    visited += 1;
    let entries: NodeFS.Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.isFile() && (!suffix || entry.name.endsWith(suffix))) found.push(full);
      if (found.length >= MAX_ENTRIES_PER_DIRECTORY) break;
    }
  }
  return found;
}

function unknown(
  input: HarnessHubDiscoveryInput,
  scope: HarnessHubScope,
  absoluteSource: string,
  source: string,
  name: string,
  problem: string,
  type: HarnessHubType = "unknown",
): HarnessHubDescriptor {
  return descriptor(input, {
    type,
    name,
    scope,
    absoluteSource,
    source,
    ownership: "unknown",
    status: "unknown",
    description: problem,
  });
}

const scrubDescription = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  // Avoid exposing arbitrary config values; descriptions are not needed for discovery.
  return value.length ? "Configured." : undefined;
};

function extractMcpServers(
  document: Record<string, unknown>,
  provider: string | undefined,
): { readonly servers?: Record<string, unknown>; readonly ambiguous?: string } {
  if (provider === "opencode") {
    const mcpValue = document.mcp;
    if (mcpValue === undefined) return {};
    const mcp = asRecord(mcpValue);
    if (!mcp) return { ambiguous: "MCP configuration has an unsupported shape." };
    if (Object.hasOwn(mcp, "servers")) {
      const servers = asRecord(mcp.servers);
      return servers ? { servers } : { ambiguous: "The mcp.servers map could not be recognized." };
    }
    const values = Object.values(mcp);
    if (values.length === 0) return { servers: mcp };
    if (
      values.every((value) => {
        const server = asRecord(value);
        return (
          server !== undefined &&
          ["command", "url", "type", "transport"].some((key) => key in server)
        );
      })
    )
      return { servers: mcp };
    return { ambiguous: "MCP configuration could not be distinguished from other mcp settings." };
  }

  if (Object.hasOwn(document, "mcpServers")) {
    const servers = asRecord(document.mcpServers);
    return servers ? { servers } : { ambiguous: "The mcpServers map could not be recognized." };
  }
  return {};
}

export async function discoverHarnessHub(
  input: HarnessHubDiscoveryInput,
): Promise<readonly HarnessHubDescriptor[]> {
  const output: HarnessHubDescriptor[] = [];
  const project = path.resolve(input.workspaceRoot);
  const home = path.resolve(input.homeDirectory);

  for (const [scope, root] of [
    ["project", project],
    ["global", home],
  ] as const) {
    const skillRoot = path.join(root, ".agents", "skills");
    const skills = (await isRealDirectory(skillRoot))
      ? await discoverSkills([{ path: skillRoot, scope: scope === "project" ? "project" : "user" }])
      : [];
    for (const skill of skills) {
      output.push(
        descriptor(input, {
          type: "skill",
          name: skill.name,
          scope,
          absoluteSource: skill.path,
          source: scope === "project" ? ".agents/skills" : "~/.agents/skills",
          ownership: skill.managed ? "managed" : "user",
        }),
      );
    }

    const rulePaths =
      scope === "project"
        ? ["AGENTS.md", "CLAUDE.md", "GEMINI.md", "copilot-instructions.md"].map((file) =>
            path.join(root, file),
          )
        : ["AGENTS.md", "CLAUDE.md"].map((file) => path.join(root, file));
    for (const file of rulePaths) {
      if (!(await lstatFile(file))) continue;
      output.push(
        descriptor(input, {
          type: "rule",
          name: path.basename(file),
          scope,
          absoluteSource: file,
          source: scope === "project" ? path.basename(file) : `~/${path.basename(file)}`,
        }),
      );
    }
    const ruleDirs =
      scope === "project"
        ? ([
            [path.join(root, ".claude", "rules"), ".claude/rules"],
            [path.join(root, ".cursor", "rules"), ".cursor/rules"],
          ] as const)
        : ([
            [path.join(root, ".claude", "rules"), "~/.claude/rules"],
            [path.join(root, ".cursor", "rules"), "~/.cursor/rules"],
          ] as const);
    for (const [directory, label] of ruleDirs) {
      for (const file of await filesUnder(directory)) {
        if (!(await lstatFile(file))) continue;
        output.push(
          descriptor(input, {
            type: "rule",
            name: path.basename(file),
            scope,
            absoluteSource: file,
            source: label,
          }),
        );
      }
    }

    const agentRoots =
      scope === "project"
        ? ([
            [path.join(root, ".claude", "agents"), ".claude/agents"],
            [path.join(root, ".opencode", "agents"), ".opencode/agents"],
            [path.join(root, ".agents", "agents"), ".agents/agents"],
          ] as const)
        : ([
            [path.join(root, ".claude", "agents"), "~/.claude/agents"],
            [path.join(root, ".opencode", "agents"), "~/.opencode/agents"],
            [path.join(root, ".agents", "agents"), "~/.agents/agents"],
          ] as const);
    for (const [directory, label] of agentRoots) {
      for (const file of await filesUnder(directory)) {
        if (!(await lstatFile(file))) continue;
        output.push(
          descriptor(input, {
            type: "agent",
            name: path.basename(file, path.extname(file)),
            scope,
            absoluteSource: file,
            source: label,
          }),
        );
      }
    }

    const configs =
      scope === "project"
        ? ([
            [path.join(root, ".mcp.json"), ".mcp.json", undefined],
            [path.join(root, ".claude", "settings.json"), ".claude/settings.json", "claude"],
            [path.join(root, ".cursor", "mcp.json"), ".cursor/mcp.json", "cursor"],
            [path.join(root, "opencode.json"), "opencode.json", "opencode"],
          ] as const)
        : ([
            [path.join(root, ".claude.json"), "~/.claude.json", "claude"],
            [path.join(root, ".cursor", "mcp.json"), "~/.cursor/mcp.json", "cursor"],
            [
              path.join(root, ".config", "opencode", "opencode.json"),
              "~/.config/opencode/opencode.json",
              "opencode",
            ],
          ] as const);
    for (const [file, label, provider] of configs) {
      const { value, problem } = await readJson(file);
      if (problem) {
        output.push(unknown(input, scope, file, label, "Configuration", problem, "mcp"));
        continue;
      }
      const doc = asRecord(value);
      if (!doc) continue;
      const extracted = extractMcpServers(doc, provider);
      if (extracted.ambiguous) {
        output.push(
          unknown(input, scope, file, label, "MCP configuration", extracted.ambiguous, "mcp"),
        );
        continue;
      }
      const mcp = extracted.servers;
      if (!mcp) continue;
      for (const [name, config] of Object.entries(mcp)) {
        if (!/^[\w .-]{1,120}$/.test(name)) {
          output.push(
            unknown(
              input,
              scope,
              file,
              label,
              "MCP server",
              "Server name could not be safely represented.",
              "mcp",
            ),
          );
          continue;
        }
        const server = asRecord(config);
        if (!server || !["command", "url", "type", "transport"].some((key) => key in server)) {
          output.push(
            unknown(
              input,
              scope,
              file,
              label,
              name,
              "Server configuration is not a recognized object.",
              "mcp",
            ),
          );
          continue;
        }
        // Do not surface environment values, command arguments, URLs, or any config payload.
        const hasSecrets =
          Object.keys(server).some(hasSecretName) || asRecord(server.env) !== undefined;
        const description = hasSecrets
          ? "Configured with sensitive fields; values hidden."
          : scrubDescription(server.command);
        output.push(
          descriptor(input, {
            type: "mcp",
            name,
            scope,
            absoluteSource: file,
            source: label,
            ...(provider ? { provider } : {}),
            ownership: "user",
            ...(description === undefined ? {} : { description }),
          }),
        );
      }
    }

    const hookConfigs =
      scope === "project"
        ? ([
            [path.join(root, ".claude", "settings.json"), ".claude/settings.json", "claude"],
            [path.join(root, ".cursor", "hooks.json"), ".cursor/hooks.json", "cursor"],
          ] as const)
        : ([
            [path.join(root, ".claude", "settings.json"), "~/.claude/settings.json", "claude"],
          ] as const);
    for (const [file, label, provider] of hookConfigs) {
      const { value, problem } = await readJson(file);
      if (problem) {
        if (!configs.some(([configuredFile]) => configuredFile === file)) {
          output.push(unknown(input, scope, file, label, "Hook configuration", problem, "hook"));
        }
        continue;
      }
      const hooks = asRecord(asRecord(value)?.hooks);
      if (!hooks) continue;
      for (const [event, definitions] of Object.entries(hooks)) {
        const count = Array.isArray(definitions) ? definitions.length : 1;
        output.push(
          descriptor(input, {
            type: "hook",
            name: `${event} (${count})`,
            scope,
            absoluteSource: file,
            source: label,
            provider,
            description: "Hook definitions detected; commands and payloads hidden.",
          }),
        );
      }
    }
  }

  return output.sort(
    (a, b) =>
      a.scope.localeCompare(b.scope) ||
      a.type.localeCompare(b.type) ||
      a.name.localeCompare(b.name),
  );
}
