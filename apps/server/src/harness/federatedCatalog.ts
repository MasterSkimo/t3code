// @effect-diagnostics nodeBuiltinImport:off -- local configuration discovery uses bounded Node filesystem reads.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { discoverHarnessHub, type HarnessHubDescriptor, type HarnessHubDiscoveryInput } from "./hubDiscovery.ts";

const fs = NodeFS.promises;
const path = NodePath;
const MAX_FILE_BYTES = 1_000_000;
const MAX_RESOURCES = 600;
const MAX_ENTRIES = 500;
const MAX_DEPTH = 6;

export type FederatedProvider = "shared" | "cursor" | "codex" | "opencode" | "claude";
export type FederatedResourceType = HarnessHubDescriptor["type"] | "command" | "config";
export type FederatedResolution = "unique" | "identical-copy" | "collision-unresolved";
export interface FederatedResource extends Omit<HarnessHubDescriptor, "type" | "scope"> {
  readonly type: FederatedResourceType;
  readonly scope: "global" | "project" | "ancestor";
  readonly fingerprint?: string;
  readonly resolution: FederatedResolution;
  readonly relatedIds: readonly string[];
  readonly compatibility: "native" | "shared-convention" | "unknown";
  readonly consumers: readonly string[];
  readonly diagnostics: readonly string[];
  readonly version?: string;
}

export interface FederatedDiscoveryInput extends HarnessHubDiscoveryInput {
  /** Local roots selected by the user; never interpreted as remote references. */
  readonly additionalRoots?: readonly { provider: FederatedProvider; directory: string }[];
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

interface Root {
  readonly provider: FederatedProvider;
  readonly directory: string;
  readonly scope: FederatedResource["scope"];
  readonly label: string;
  readonly projectId?: string;
}

// A root with a symbolic-link ancestor is never traversed.
async function safeDirectory(directory: string): Promise<boolean> {
  let current = path.resolve(directory);
  while (true) {
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) return false;
      if (current === path.resolve(directory) && !stat.isDirectory()) return false;
    } catch {
      return false;
    }
    const parent = path.dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

async function readSafeFile(file: string): Promise<Buffer | undefined> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) return undefined;
    return await fs.readFile(file);
  } catch {
    return undefined;
  }
}

const hash = (input: string | Buffer) => NodeCrypto.createHash("sha256").update(input).digest("hex");
const safeName = (value: string) => value.replace(/[\r\n\0]/g, " ").slice(0, 120);
const typeFromFolder: Readonly<Record<string, FederatedResourceType>> = {
  skills: "skill", skill: "skill", rules: "rule", agents: "agent",
  agent: "agent", commands: "command", command: "command",
};
const typeExtensions = /\.(md|mdc|markdown|txt)$/i;

function resource(
  root: Root, type: FederatedResourceType, absolute: string, name: string,
  fingerprint?: string, diagnostics: readonly string[] = [],
): FederatedResource {
  const source = `${root.label}/${path.relative(root.directory, absolute).replaceAll(path.sep, "/")}`;
  return {
    id: `${type}:${hash(`${path.resolve(absolute)}\0${name}`).slice(0, 24)}`,
    type,
    name: safeName(name),
    scope: root.scope,
    ...(root.projectId ? { projectId: root.projectId } : {}),
    provider: root.provider,
    source,
    ownership: "user",
    status: diagnostics.length ? "unknown" : "installed",
    operations: [],
    ...(fingerprint ? { fingerprint } : {}),
    resolution: "unique",
    relatedIds: [],
    compatibility: root.provider === "shared" ? "shared-convention" : "native",
    consumers: root.provider === "shared" ? [] : [root.provider],
    diagnostics,
  };
}

function ancestorRoots(input: FederatedDiscoveryInput): Root[] {
  if (!input.projectId) return [];
  const home = path.resolve(input.homeDirectory);
  let current = path.resolve(input.workspaceRoot);
  const roots: Root[] = [];
  for (let depth = 0; depth < 10; depth++) {
    const scope = depth === 0 ? "project" : "ancestor";
    const label = depth === 0 ? "" : `ancestor-${depth}/`;
    const entries: readonly [FederatedProvider, string][] = [
      ["shared", ".agents"], ["cursor", ".cursor"], ["codex", ".codex"],
      ["opencode", ".opencode"], ["claude", ".claude"],
    ];
    for (const [provider, segment] of entries) {
      roots.push({ provider, directory: path.join(current, segment), scope,
        label: `${label}${segment}`, projectId: input.projectId });
    }
    if (current === home || current === path.dirname(current)) break;
    // Never cross the worktree boundary when determining effective project configuration.
    if (NodeFS.existsSync(path.join(current, ".git"))) break;
    current = path.dirname(current);
  }
  return roots;
}

function configuredRoots(input: FederatedDiscoveryInput): Root[] {
  const home = path.resolve(input.homeDirectory);
  const env = input.environment ?? process.env;
  const xdg = env.XDG_CONFIG_HOME || path.join(home, ".config");
  const codex = env.CODEX_HOME || path.join(home, ".codex");
  const opencode = env.OPENCODE_CONFIG_DIR || path.join(xdg, "opencode");
  const defaults: Root[] = [
    { provider: "shared", directory: path.join(home, ".agents"), scope: "global", label: "~/.agents" },
    { provider: "cursor", directory: path.join(home, ".cursor"), scope: "global", label: "~/.cursor" },
    { provider: "codex", directory: codex, scope: "global", label: "$CODEX_HOME" },
    { provider: "opencode", directory: opencode, scope: "global", label: "opencode-config" },
    { provider: "claude", directory: path.join(home, ".claude"), scope: "global", label: "~/.claude" },
    ...ancestorRoots(input),
  ];
  for (const [index, additional] of (input.additionalRoots ?? []).slice(0, 16).entries()) {
    if (!path.isAbsolute(additional.directory)) continue;
    defaults.push({ provider: additional.provider, directory: path.resolve(additional.directory),
      scope: "global", label: `additional-${index}` });
  }
  // Same directory can be a compatibility source for several providers; ownership stays at its origin.
  const seen = new Set<string>();
  return defaults.filter((root) => {
    const key = `${root.provider}\0${root.directory}\0${root.scope}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 64);
}

async function walk(
  root: Root, directory: string, type: FederatedResourceType,
  results: FederatedResource[], depth = 0,
): Promise<void> {
  if (depth > MAX_DEPTH || results.length >= MAX_RESOURCES || !(await safeDirectory(directory))) return;
  let entries: NodeFS.Dirent[];
  try {
    entries = (await fs.readdir(directory, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_ENTRIES);
  } catch {
    return;
  }
  // A skill is a directory with its own entrypoint; its support files must not become resources.
  const manifest = await readSafeFile(path.join(directory, "SKILL.md"));
  if (type === "skill" && manifest) {
    results.push(resource(root, "skill", path.join(directory, "SKILL.md"),
      path.basename(directory), hash(manifest)));
    return;
  }
  for (const entry of entries) {
    if (results.length >= MAX_RESOURCES || entry.isSymbolicLink()) break;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(root, full, type, results, depth + 1);
    } else if (entry.isFile() && typeExtensions.test(entry.name) &&
      !(type === "skill" && entry.name === "SKILL.md")) {
      const bytes = await readSafeFile(full);
      if (bytes) results.push(resource(root, type, full,
        path.basename(entry.name, path.extname(entry.name)), hash(bytes)));
    }
  }
}

async function scanConfig(root: Root, file: string, results: FederatedResource[]): Promise<void> {
  const data = await readSafeFile(file);
  if (!data) return;
  const base = path.basename(file);
  const fp = hash(data);
  results.push(resource(root, "config", file, base, fp));
  if (!base.endsWith(".json")) return; // JSONC/TOML requires provider parsers; do not guess.
  let doc: unknown;
  try { doc = JSON.parse(data.toString("utf8")) as unknown; }
  catch {
    results.push(resource(root, "config", file, `${base}:parse-error`, fp, ["malformed-config"]));
    return;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return;
  const settings = doc as Record<string, unknown>;
  const mcpValue = root.provider === "opencode" ? settings.mcp : settings.mcpServers;
  const mcp = mcpValue && typeof mcpValue === "object" && !Array.isArray(mcpValue)
    ? mcpValue as Record<string, unknown> : undefined;
  // Do not emit or model-summarize command args, env, URLs, headers or secret values.
  const serverMap = mcp?.servers && typeof mcp.servers === "object" && !Array.isArray(mcp.servers)
    ? mcp.servers as Record<string, unknown> : mcp;
  if (serverMap) {
    for (const [name, value] of Object.entries(serverMap).slice(0, 100)) {
      if (!/^[\w .-]{1,120}$/.test(name) || !value || typeof value !== "object" || Array.isArray(value))
        continue;
      if (!["command", "url", "type", "transport"].some((key) => key in value)) continue;
      results.push(resource(root, "mcp", file, name, fp));
    }
  }
  if (settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks)) {
    for (const name of Object.keys(settings.hooks).slice(0, 100)) {
      if (/^[\w .-]{1,120}$/.test(name)) results.push(resource(root, "hook", file, name, fp));
    }
  }
}

async function scanRoot(root: Root, results: FederatedResource[]): Promise<void> {
  if (!(await safeDirectory(root.directory))) return;
  for (const [folder, type] of Object.entries(typeFromFolder)) {
    await walk(root, path.join(root.directory, folder), type, results);
  }
  for (const file of ["AGENTS.md", "CLAUDE.md", "settings.json", "opencode.json",
    "opencode.jsonc", "config.toml", "mcp.json", "hooks.json"]) {
    const absolute = path.join(root.directory, file);
    if (file.endsWith(".md")) {
      const bytes = await readSafeFile(absolute);
      if (bytes) results.push(resource(root, "rule", absolute, file, hash(bytes)));
    } else {
      await scanConfig(root, absolute, results);
    }
  }
}

/** Single metadata-only discovery entrypoint shared by Hub and learning. */
export async function discoverFederatedCatalog(
  input: FederatedDiscoveryInput,
): Promise<readonly FederatedResource[]> {
  const resources: FederatedResource[] = [];
  // Retain existing Hub adapters until they can be retired without changing source semantics.
  const legacy = await discoverHarnessHub(input);
  for (const item of legacy) {
    resources.push({
      ...item, resolution: "unique", relatedIds: [], compatibility: "unknown",
      consumers: item.provider ? [item.provider] : [], diagnostics: [],
    });
  }
  for (const root of configuredRoots(input)) {
    if (resources.length >= MAX_RESOURCES) break;
    await scanRoot(root, resources);
  }
  const unique = new Map<string, FederatedResource>();
  for (const item of resources) {
    const previous = unique.get(item.id);
    unique.set(item.id, previous
      ? { ...item, ownership: previous.ownership === "managed" ? "managed" : item.ownership }
      : item);
  }
  const entries = [...unique.values()];
  const names = new Map<string, FederatedResource[]>();
  for (const entry of entries) {
    const key = `${entry.type}\0${entry.name.toLocaleLowerCase()}`;
    const matches = names.get(key) ?? [];
    matches.push(entry);
    names.set(key, matches);
  }
  return entries.map((entry) => {
    const group = names.get(`${entry.type}\0${entry.name.toLocaleLowerCase()}`)!;
    const others = group.filter((candidate) => candidate.id !== entry.id);
    return {
      ...entry,
      resolution: others.length === 0 ? "unique"
        : entry.fingerprint && others.every((other) => other.fingerprint === entry.fingerprint)
          ? "identical-copy" : "collision-unresolved",
      relatedIds: others.map((other) => other.id),
    };
  }).sort((a, b) => a.scope.localeCompare(b.scope) || a.type.localeCompare(b.type)
    || a.name.localeCompare(b.name) || a.provider!.localeCompare(b.provider ?? ""));
}
