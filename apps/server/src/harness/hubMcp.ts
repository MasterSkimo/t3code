// @effect-diagnostics nodeBuiltinImport:off -- native configuration updates require guarded atomic filesystem writes.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { lock } from "proper-lockfile";

export type HubMcpProvider = "codex" | "claude" | "opencode";

export type PortableMcpServer =
  | {
      readonly transport: "stdio";
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      /** Values must be provider-native environment references, never secret values. */
      readonly env?: Readonly<Record<string, string>>;
    }
  | {
      readonly transport: "http";
      readonly url: string;
      /** Values must be provider-native environment references, never secret values. */
      readonly headers?: Readonly<Record<string, string>>;
    };

export type NativeMcpRead = {
  readonly provider: HubMcpProvider;
  readonly servers: ReadonlyArray<{
    readonly name: string;
    readonly configuration: unknown;
    readonly fingerprint: string;
  }>;
};

export type NativeMcpWriteResult =
  | { readonly status: "written"; readonly contents: string; readonly fileFingerprint: string }
  | { readonly status: "unchanged"; readonly contents: string; readonly fileFingerprint: string }
  | { readonly status: "conflict"; readonly reason: string }
  | { readonly status: "unsupported"; readonly reason: string };

const SECRET_KEY = /(?:secret|token|password|credential|authorization|api[-_]?key)/i;
const ENV_REFERENCE = /^(?:\$\{[A-Za-z_][A-Za-z0-9_]*\}|\{env:[A-Za-z_][A-Za-z0-9_]*\})$/;
const CREDENTIAL_FLAG =
  /^--?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|secret|authorization|auth|client[-_]?secret)(?:=|$)/i;
const CREDENTIAL_VALUE =
  /(?:\bbearer\s+[a-z0-9._~-]{8,}|\bgh[pousr]_[a-z0-9]{20,}|\bglpat-[a-z0-9_-]{16,}|\bxox[baprs]-[a-z0-9-]{16,}|\bsk-[a-z0-9_-]{20,}|\beyj[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,})/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
};

export const hubMcpFingerprint = (value: unknown): string =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");

export const nativeMcpDrift = (
  lastAppliedFingerprint: string,
  currentConfiguration: unknown | undefined,
): "synchronized" | "drifted" | "missing" => {
  if (currentConfiguration === undefined) return "missing";
  return hubMcpFingerprint(currentConfiguration) === lastAppliedFingerprint
    ? "synchronized"
    : "drifted";
};

export const redactHubMcpSecrets = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactHubMcpSecrets);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      SECRET_KEY.test(key) ? "[redacted]" : redactHubMcpSecrets(child),
    ]),
  );
};

const getServerMap = (
  provider: HubMcpProvider,
  document: Record<string, unknown>,
): Record<string, unknown> | undefined => {
  if (provider === "claude") {
    return isRecord(document.mcpServers) ? document.mcpServers : undefined;
  }
  if (provider === "opencode") {
    if (!isRecord(document.mcp)) return undefined;
    const mcp = document.mcp;
    // OpenCode v2 nests servers; v1 put names directly under `mcp`.
    if (isRecord(mcp.servers)) return mcp.servers;
    return mcp;
  }
  return undefined;
};

const parseStrictJson = (contents: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(contents);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

type JsonObjectNode = {
  readonly kind: "object";
  readonly start: number;
  readonly end: number;
  readonly properties: ReadonlyMap<string, { readonly keyStart: number; readonly value: JsonNode }>;
};
type JsonNode =
  | JsonObjectNode
  | { readonly kind: "array"; readonly start: number; readonly end: number }
  | { readonly kind: "value"; readonly start: number; readonly end: number };

const skipWhitespace = (text: string, from: number): number => {
  let index = from;
  while (/\s/.test(text[index] ?? "")) index += 1;
  return index;
};

const parseStringEnd = (text: string, start: number): number => {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === "\\") index += 2;
    else if (text[index] === '"') return index + 1;
    else index += 1;
  }
  throw new Error("Invalid JSON string");
};

const scanJsonNode = (text: string, offset: number): JsonNode => {
  const start = skipWhitespace(text, offset);
  if (text[start] === "{") {
    const properties = new Map<string, { keyStart: number; value: JsonNode }>();
    let index = skipWhitespace(text, start + 1);
    while (text[index] !== "}") {
      const keyStart = index;
      const keyEnd = parseStringEnd(text, keyStart);
      const key = JSON.parse(text.slice(keyStart, keyEnd)) as string;
      const value = scanJsonNode(text, skipWhitespace(text, keyEnd) + 1);
      properties.set(key, { keyStart, value });
      index = skipWhitespace(text, value.end);
      if (text[index] === ",") index = skipWhitespace(text, index + 1);
      else break;
    }
    return { kind: "object", start, end: index + 1, properties };
  }
  if (text[start] === "[") {
    let index = skipWhitespace(text, start + 1);
    while (text[index] !== "]") {
      const value = scanJsonNode(text, index);
      index = skipWhitespace(text, value.end);
      if (text[index] === ",") index = skipWhitespace(text, index + 1);
      else break;
    }
    return { kind: "array", start, end: index + 1 };
  }
  if (text[start] === '"') return { kind: "value", start, end: parseStringEnd(text, start) };
  let index = start;
  while (index < text.length && !/[\s,}\]]/.test(text[index]!)) index += 1;
  return { kind: "value", start, end: index };
};

const objectProperty = (node: JsonNode, key: string): JsonNode | undefined =>
  node.kind === "object" ? node.properties.get(key)?.value : undefined;

const indentationAt = (text: string, position: number): string => {
  const lineStart = text.lastIndexOf("\n", position - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart, position))?.[0] ?? "";
};

const insertObjectProperty = (
  text: string,
  object: JsonObjectNode,
  name: string,
  value: unknown,
): string => {
  const close = object.end - 1;
  let insertion = close;
  while (insertion > object.start + 1 && /\s/.test(text[insertion - 1]!)) insertion -= 1;
  const closingIndent = indentationAt(text, close);
  const firstProperty = object.properties.values().next().value as
    | { readonly keyStart: number; readonly value: JsonNode }
    | undefined;
  const indent = firstProperty ? indentationAt(text, firstProperty.keyStart) : `${closingIndent}  `;
  const valueText = JSON.stringify(value, null, 2).replace(/\n/g, `\n${indent}`);
  const separator = object.properties.size > 0 ? "," : "";
  const addition = `${separator}\n${indent}${JSON.stringify(name)}: ${valueText}\n${closingIndent}`;
  return `${text.slice(0, insertion)}${addition}${text.slice(close)}`;
};

const patchNativeJson = (
  provider: "claude" | "opencode",
  original: string,
  name: string,
  desired: Record<string, unknown>,
): string => {
  const root = scanJsonNode(original, 0);
  if (root.kind !== "object") throw new Error("Configuration root must be an object");
  if (provider === "claude") {
    const map = objectProperty(root, "mcpServers");
    if (map?.kind === "object") {
      const existing = map.properties.get(name)?.value;
      if (existing)
        return `${original.slice(0, existing.start)}${JSON.stringify(desired)}${original.slice(existing.end)}`;
      return insertObjectProperty(original, map, name, desired);
    }
    return insertObjectProperty(original, root, "mcpServers", { [name]: desired });
  }
  const mcp = objectProperty(root, "mcp");
  if (mcp?.kind !== "object") {
    return insertObjectProperty(original, root, "mcp", { servers: { [name]: desired } });
  }
  const currentServers = objectProperty(mcp, "servers");
  if (currentServers?.kind === "object") {
    const existing = currentServers.properties.get(name)?.value;
    if (existing)
      return `${original.slice(0, existing.start)}${JSON.stringify(desired)}${original.slice(existing.end)}`;
    return insertObjectProperty(original, currentServers, name, desired);
  }
  if (mcp.properties.size === 0) {
    return insertObjectProperty(original, mcp, "servers", { [name]: desired });
  }
  const existing = mcp.properties.get(name)?.value;
  if (existing)
    return `${original.slice(0, existing.start)}${JSON.stringify(desired)}${original.slice(existing.end)}`;
  return insertObjectProperty(original, mcp, name, desired);
};

/** Read-only discovery. Codex TOML and JSONC files are deliberately not parsed by this adapter. */
export const discoverNativeMcp = (
  provider: HubMcpProvider,
  contents: string,
): NativeMcpRead | { readonly provider: HubMcpProvider; readonly unsupported: string } => {
  if (provider === "codex") {
    return { provider, unsupported: "Codex uses config.toml; this adapter does not parse TOML." };
  }
  const document = parseStrictJson(contents);
  if (!document) {
    return {
      provider,
      unsupported:
        "Configuration is not strict JSON; comments, JSONC, and malformed files are left untouched.",
    };
  }
  const servers = getServerMap(provider, document);
  if (!servers) return { provider, servers: [] };
  return {
    provider,
    servers: Object.entries(servers).map(([name, configuration]) => ({
      name,
      configuration: redactHubMcpSecrets(configuration),
      fingerprint: hubMcpFingerprint(configuration),
    })),
  };
};

const validatePortable = (server: PortableMcpServer): string | undefined => {
  if (server.transport === "stdio") {
    for (let index = 0; index < server.args.length; index += 1) {
      const arg = server.args[index]!;
      if (CREDENTIAL_FLAG.test(arg)) {
        return "Command arguments cannot contain inline credentials; use a provider-native environment reference.";
      }
      if (CREDENTIAL_VALUE.test(arg)) {
        return "Command arguments contain a credential-like value and cannot be distributed.";
      }
    }
    if (CREDENTIAL_VALUE.test(server.command)) {
      return "Command contains a credential-like value and cannot be distributed.";
    }
    for (const [key, value] of Object.entries(server.env ?? {})) {
      if (SECRET_KEY.test(key) && !ENV_REFERENCE.test(value)) {
        return `Secret environment value for ${key} cannot be distributed; use a provider-native environment reference.`;
      }
    }
    return;
  }
  try {
    const url = new URL(server.url);
    if (url.protocol !== "https:" || url.username || url.password) {
      return "Only HTTPS MCP URLs without embedded credentials can be distributed.";
    }
    const decodedPath = decodeURIComponent(url.pathname);
    const hasOpaquePathSegment = decodedPath
      .split("/")
      .some((segment) => segment.length >= 40 && /^[a-z0-9_-]+$/i.test(segment));
    if (
      url.search ||
      url.hash ||
      /\/(?:access[-_]?token|refresh[-_]?token|tokens?|auth(?:orization)?|keys?|secrets?|credentials?)\//i.test(
        decodedPath,
      ) ||
      CREDENTIAL_VALUE.test(decodedPath) ||
      hasOpaquePathSegment
    ) {
      return "URLs with query values or credential-like path segments cannot be distributed.";
    }
  } catch {
    return "MCP URL is invalid.";
  }
  for (const [key, value] of Object.entries(server.headers ?? {})) {
    if (SECRET_KEY.test(key) && !ENV_REFERENCE.test(value)) {
      return `Secret header ${key} cannot be distributed; use a provider-native environment reference.`;
    }
  }
};

const toNativeConfig = (
  provider: "claude" | "opencode",
  server: PortableMcpServer,
): Record<string, unknown> => {
  if (provider === "claude") {
    return server.transport === "stdio"
      ? {
          command: server.command,
          args: [...server.args],
          ...(server.env === undefined ? {} : { env: { ...server.env } }),
        }
      : {
          type: "http",
          url: server.url,
          ...(server.headers === undefined ? {} : { headers: { ...server.headers } }),
        };
  }
  return server.transport === "stdio"
    ? {
        type: "local",
        command: [server.command, ...server.args],
        ...(server.env === undefined ? {} : { environment: { ...server.env } }),
      }
    : {
        type: "remote",
        url: server.url,
        ...(server.headers === undefined ? {} : { headers: { ...server.headers } }),
      };
};

const setServerMap = (
  provider: "claude" | "opencode",
  document: Record<string, unknown>,
): Record<string, unknown> => {
  if (provider === "claude") {
    if (document.mcpServers === undefined) document.mcpServers = {};
    if (!isRecord(document.mcpServers)) throw new Error("mcpServers is not an object");
    return document.mcpServers;
  }
  if (document.mcp === undefined) document.mcp = {};
  if (!isRecord(document.mcp)) throw new Error("OpenCode mcp is not an object");
  const mcp = document.mcp;
  if (mcp.servers !== undefined) {
    if (!isRecord(mcp.servers)) throw new Error("mcp.servers is not an object");
    return mcp.servers;
  }
  // OpenCode v1 used direct server entries. Empty or unfamiliar configs do not reveal the version.
  if (Object.keys(mcp).length === 0) {
    throw new Error("OpenCode config version is unknown; an empty MCP section is left untouched.");
  }
  if (
    !Object.values(mcp).every(
      (entry) =>
        isRecord(entry) &&
        (entry.type === "local" ||
          entry.type === "remote" ||
          typeof entry.command === "string" ||
          Array.isArray(entry.command) ||
          typeof entry.url === "string"),
    )
  ) {
    throw new Error("OpenCode MCP schema is unknown; configuration is left untouched.");
  }
  return mcp;
};

/**
 * Build a guarded JSON update that edits only the target server value. New names can be added; an existing name can only be
 * replaced when the caller supplies the fingerprint it last applied. No merge is guessed.
 */
export const planNativeMcpWrite = (input: {
  readonly provider: HubMcpProvider;
  readonly contents: string | null;
  readonly expectedFileFingerprint: string;
  readonly name: string;
  readonly server: PortableMcpServer;
  readonly expectedEntryFingerprint?: string;
}): NativeMcpWriteResult => {
  if (input.provider === "codex") {
    return { status: "unsupported", reason: "Codex uses TOML; this adapter will not rewrite it." };
  }
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(input.name)) {
    return { status: "unsupported", reason: "Server name contains unsupported characters." };
  }
  const validationError = validatePortable(input.server);
  if (validationError) return { status: "unsupported", reason: validationError };
  const currentFileFingerprint =
    input.contents === null ? "missing" : hubMcpFingerprint(input.contents);
  if (currentFileFingerprint !== input.expectedFileFingerprint) {
    return {
      status: "conflict",
      reason: "Native configuration changed since the preview was created.",
    };
  }
  const document = input.contents === null ? {} : parseStrictJson(input.contents);
  if (!document) {
    return {
      status: "unsupported",
      reason:
        "Configuration is not strict JSON; comments, JSONC, and malformed files are left untouched.",
    };
  }
  let servers: Record<string, unknown>;
  try {
    servers = setServerMap(input.provider, document);
  } catch (error) {
    return {
      status: "unsupported",
      reason: error instanceof Error ? error.message : "Invalid MCP configuration.",
    };
  }
  const desired = toNativeConfig(input.provider, input.server);
  const existing = servers[input.name];
  if (existing !== undefined) {
    if (hubMcpFingerprint(existing) === hubMcpFingerprint(desired)) {
      return {
        status: "unchanged",
        contents: input.contents!,
        fileFingerprint: currentFileFingerprint,
      };
    }
    if (
      input.expectedEntryFingerprint === undefined ||
      hubMcpFingerprint(existing) !== input.expectedEntryFingerprint
    ) {
      return { status: "conflict", reason: "A different native server already uses this name." };
    }
  }
  const original = input.contents ?? "{}";
  const contents = patchNativeJson(input.provider, original, input.name, desired);
  return { status: "written", contents, fileFingerprint: hubMcpFingerprint(contents) };
};

/**
 * Apply a planned strict-JSON change to an existing provider file. The path is supplied by the
 * environment-scoped caller; symlinks are refused and the target is rechecked before rename.
 */
type ApplyNativeMcpWriteInput = {
  readonly filePath: string;
  readonly provider: HubMcpProvider;
  readonly expectedFileFingerprint: string;
  readonly name: string;
  readonly server: PortableMcpServer;
  readonly expectedEntryFingerprint?: string;
};

const applyNativeMcpWriteUnlocked = async (
  input: ApplyNativeMcpWriteInput,
): Promise<NativeMcpWriteResult> => {
  let original: string | null;
  let mode = 0o600;
  try {
    const stat = await NodeFSP.lstat(input.filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return {
        status: "unsupported",
        reason: "Target must be a regular, non-symlink configuration file.",
      };
    }
    mode = stat.mode & 0o777;
    original = await NodeFSP.readFile(input.filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { status: "unsupported", reason: "Could not safely read the native configuration." };
    }
    original = null;
  }
  const plan = planNativeMcpWrite({ ...input, contents: original });
  if (plan.status !== "written") return plan;
  const directory = NodePath.dirname(input.filePath);
  const temporaryPath = NodePath.join(
    directory,
    `.${NodePath.basename(input.filePath)}.${NodeCrypto.randomUUID()}.tmp`,
  );
  try {
    await NodeFSP.writeFile(temporaryPath, plan.contents, { encoding: "utf8", flag: "wx", mode });
    let latest: string | null;
    try {
      const stat = await NodeFSP.lstat(input.filePath);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Target changed.");
      latest = await NodeFSP.readFile(input.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      latest = null;
    }
    const latestFingerprint = latest === null ? "missing" : hubMcpFingerprint(latest);
    if (latestFingerprint !== input.expectedFileFingerprint) {
      return {
        status: "conflict",
        reason: "Native configuration changed before the update could be applied.",
      };
    }
    await NodeFSP.rename(temporaryPath, input.filePath);
    return plan;
  } catch {
    return {
      status: "unsupported",
      reason: "Could not safely apply the native configuration update.",
    };
  } finally {
    await NodeFSP.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
};

const assertRealParentDirectories = async (filePath: string): Promise<string> => {
  const absolute = NodePath.resolve(filePath);
  const directory = NodePath.dirname(absolute);
  const root = NodePath.parse(directory).root;
  let current = root;
  for (const segment of directory.slice(root.length).split(NodePath.sep).filter(Boolean)) {
    current = NodePath.join(current, segment);
    const stat = await NodeFSP.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Configuration parent is not a real directory.");
    }
  }
  const realDirectory = await NodeFSP.realpath(directory);
  if (realDirectory !== directory) throw new Error("Configuration parent path is not canonical.");
  return directory;
};

/** Serializes Harness writers and rechecks the file immediately before replacement. */
export const applyNativeMcpWrite = async (
  input: ApplyNativeMcpWriteInput,
): Promise<NativeMcpWriteResult> => {
  let directory: string;
  try {
    directory = await assertRealParentDirectories(input.filePath);
  } catch {
    return {
      status: "unsupported",
      reason: "Configuration path contains a missing or unsafe parent directory.",
    };
  }
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lock(directory, {
      realpath: false,
      stale: 30_000,
      update: 5_000,
      retries: { retries: 5, factor: 1, minTimeout: 20, maxTimeout: 50 },
    });
    return await applyNativeMcpWriteUnlocked(input);
  } catch {
    return {
      status: "conflict",
      reason:
        "Another Harness update is editing this configuration, or the safe update could not complete.",
    };
  } finally {
    if (release) await release().catch(() => undefined);
  }
};
