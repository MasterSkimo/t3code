// @effect-diagnostics nodeBuiltinImport:off -- scope changes operate only on server-resolved skill files.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  applySkillChange,
  commitSkillChange,
  discoverSkills,
  recoverSkillChange,
  rollbackSkillChange,
  type DiscoveredSkill,
  type SkillChangeReceipt,
  type SkillScope,
} from "./skills.ts";

const fs = NodeFS.promises;
const HISTORY_DIRECTORY = ".harness-scope-history";
const safeSegment = (value: string) =>
  value.length > 0 && value !== "." && value !== ".." && /^[\p{L}\p{N}._-]+$/u.test(value);
const hash = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const FRONTMATTER = /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/;
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/i,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|sk-[A-Za-z0-9]{20,})\b/,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{12,}/i,
];

export type HubSkillScope = "project" | "global";
export type SkillScopeResolution = "replace-managed";

export interface SkillScopePreview {
  readonly id: string;
  readonly confirmationToken: string;
  readonly source: {
    readonly id: string;
    readonly name: string;
    readonly scope: SkillScope;
    readonly path: string;
    readonly fingerprint: string;
  };
  readonly destination: {
    readonly scope: HubSkillScope;
    readonly root: string;
    readonly name: string;
  };
  readonly diff: { readonly before: string | null; readonly after: string };
  readonly conflicts: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly managed: boolean;
    readonly path: string;
  }>;
}

export interface SkillScopeHistoryEntry {
  readonly id: string;
  readonly createdAt: string;
  readonly source: SkillScopePreview["source"];
  readonly destination: SkillScopePreview["destination"];
  readonly receipt: SkillChangeReceipt;
}

function scopeKind(scope: SkillScope): HubSkillScope | undefined {
  if (scope === "project") return "project";
  if (scope === "user") return "global";
  return undefined;
}

function assertNativeSkillsRoot(root: string): string {
  const absolute = NodePath.resolve(root);
  if (
    NodePath.basename(absolute) !== "skills" ||
    NodePath.basename(NodePath.dirname(absolute)) !== ".agents"
  )
    throw new Error("Scope operations require a server-resolved .agents/skills root");
  return absolute;
}

function withSkillName(content: string, name: string): string {
  const match = FRONTMATTER.exec(content);
  if (!match) throw new Error("A renamed copy requires editable skill name frontmatter");
  const fields = match[2] ?? "";
  const nameField = /^([ \t]*name:[ \t]*)(.*)$/m;
  if (!nameField.test(fields))
    throw new Error("A renamed copy requires a name field in frontmatter");
  return content.replace(
    FRONTMATTER,
    (_whole, start: string, body: string, end: string) =>
      `${start}${body.replace(nameField, (_line, prefix: string) => `${prefix}${JSON.stringify(name)}`)}${end}`,
  );
}

function previewToken(preview: Omit<SkillScopePreview, "confirmationToken">): string {
  return hash(
    JSON.stringify({
      id: preview.id,
      source: preview.source,
      destination: preview.destination,
      diff: preview.diff,
      conflicts: preview.conflicts,
    }),
  );
}

function assertNoCredentials(content: string): void {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(content)))
    throw new Error(
      "Skill content appears to contain credentials; remove them before changing scope",
    );
}

async function readSource(source: DiscoveredSkill): Promise<string> {
  const absolute = NodePath.resolve(source.path);
  const directory = NodePath.dirname(absolute);
  const sourceRoot = NodePath.dirname(directory);
  assertNativeSkillsRoot(sourceRoot);
  const dirStat = await fs.lstat(directory);
  const fileStat = await fs.lstat(absolute);
  if (
    !dirStat.isDirectory() ||
    dirStat.isSymbolicLink() ||
    !fileStat.isFile() ||
    fileStat.isSymbolicLink()
  )
    throw new Error("Skill source is not a safe regular file");
  const content = await fs.readFile(absolute, "utf8");
  if ((await fs.realpath(directory)) !== directory)
    throw new Error("Skill source resolves through a symlink");
  if (content !== source.content) throw new Error("Skill source changed after discovery");
  return content;
}

/** Build a read-only, fingerprinted preview for a project/global skill copy. */
export async function previewSkillScopeChange(
  source: DiscoveredSkill,
  destinationRoot: string,
  destinationScope: HubSkillScope,
  destinationName = source.name,
): Promise<SkillScopePreview> {
  if (scopeKind(source.scope) === undefined || scopeKind(source.scope) === destinationScope)
    throw new Error("Only project-to-global or global-to-project skill copies are supported");
  if (!destinationName.trim() || destinationName.length > 120)
    throw new Error("Destination skill name is invalid");
  const sourceContent = await readSource(source);
  assertNoCredentials(sourceContent);
  const content =
    destinationName === source.name ? sourceContent : withSkillName(sourceContent, destinationName);
  const root = assertNativeSkillsRoot(destinationRoot);
  const existing = await discoverSkills([
    { path: root, scope: destinationScope === "global" ? "user" : "project" },
  ]);
  const conflicts = existing
    .filter((skill) => skill.name.toLocaleLowerCase() === destinationName.toLocaleLowerCase())
    .map(({ id, name, managed, path }) => ({ id, name, managed, path }));
  const before = conflicts[0] ? await fs.readFile(conflicts[0].path, "utf8") : null;
  if (before !== null) assertNoCredentials(before);
  const fingerprint = hash(`${NodePath.resolve(source.path)}\0${sourceContent}`);
  const id = NodeCrypto.randomUUID();
  const preview = {
    id,
    source: {
      id: source.id,
      name: source.name,
      scope: source.scope,
      path: NodePath.resolve(source.path),
      fingerprint,
    },
    destination: { scope: destinationScope, root, name: destinationName },
    diff: { before, after: content },
    conflicts,
  };
  return { ...preview, confirmationToken: previewToken(preview) };
}

function validatePreview(preview: SkillScopePreview): void {
  const { confirmationToken: _token, ...unsigned } = preview;
  const expected = previewToken(unsigned);
  if (preview.confirmationToken !== expected)
    throw new Error("Scope preview changed; review it again");
}

async function historyRoot(root: string, create: boolean): Promise<string> {
  const absolute = assertNativeSkillsRoot(root);
  if (create) await fs.mkdir(absolute, { recursive: true });
  const stat = await fs.lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.realpath(absolute)) !== absolute)
    throw new Error("Skill destination root is not a safe directory");
  const history = NodePath.join(absolute, HISTORY_DIRECTORY);
  if (create) await fs.mkdir(history, { recursive: true });
  const info = await fs.lstat(history).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (
    info &&
    (!info.isDirectory() || info.isSymbolicLink() || (await fs.realpath(history)) !== history)
  )
    throw new Error("Skill history directory is not safe");
  return history;
}

/** Recover interrupted scope transactions before serving scope history or previews. */
export async function recoverSkillScopeChanges(destinationRoot: string): Promise<void> {
  const root = assertNativeSkillsRoot(destinationRoot);
  const journal = NodePath.join(root, ".harness-journal");
  const journalStat = await fs.lstat(journal).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!journalStat) return;
  if (
    !journalStat.isDirectory() ||
    journalStat.isSymbolicLink() ||
    (await fs.realpath(journal)) !== journal
  )
    throw new Error("Skill recovery journal is unsafe");
  for (const filename of (await fs.readdir(journal)).sort()) {
    const match = /^scope-([\p{L}\p{N}._-]+)\.json$/u.exec(filename);
    if (!match || !safeSegment(match[1]!)) continue;
    const transactionId = `scope-${match[1]}`;
    await recoverSkillChange(root, transactionId);
    const history = await historyRoot(root, false);
    await fs.rm(NodePath.join(history, `${match[1]}.json`), { force: true });
  }
}

/** Apply only after the caller returns the exact token shown with the preview. */
export async function applySkillScopeChange(
  preview: SkillScopePreview,
  confirmationToken: string,
  createdAt: string,
  resolution?: SkillScopeResolution,
): Promise<SkillScopeHistoryEntry> {
  if (!safeSegment(preview.id)) throw new Error("Invalid scope preview id");
  validatePreview(preview);
  if (confirmationToken !== preview.confirmationToken)
    throw new Error("Explicit confirmation is required to change skill scope");
  const history = await historyRoot(preview.destination.root, true);
  const historyFile = NodePath.join(history, `${preview.id}.json`);
  await fs
    .lstat(historyFile)
    .then(() => {
      throw new Error("This scope preview was already applied");
    })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  const sourceContent = await fs.readFile(preview.source.path, "utf8");
  if (hash(`${preview.source.path}\0${sourceContent}`) !== preview.source.fingerprint)
    throw new Error("Skill source changed after preview; review a new preview");
  const expectedAfter =
    preview.destination.name === preview.source.name
      ? sourceContent
      : withSkillName(sourceContent, preview.destination.name);
  if (preview.diff.after !== expectedAfter)
    throw new Error("Scope preview content changed; review it again");
  const currentDestinationSkills = await discoverSkills([
    {
      path: preview.destination.root,
      scope: preview.destination.scope === "global" ? "user" : "project",
    },
  ]);
  const currentConflicts = currentDestinationSkills
    .filter(
      (skill) => skill.name.toLocaleLowerCase() === preview.destination.name.toLocaleLowerCase(),
    )
    .map(({ id, name, managed, path }) => ({ id, name, managed, path }));
  if (JSON.stringify(currentConflicts) !== JSON.stringify(preview.conflicts))
    throw new Error("Destination changed after preview; review a new preview");
  const name = preview.destination.name;
  const content = preview.diff.after;
  let targetId: string;
  let expectedCurrent: string | undefined;
  if (preview.conflicts.length > 0) {
    if (
      resolution === "replace-managed" &&
      preview.conflicts.length === 1 &&
      preview.conflicts[0]!.managed
    ) {
      const conflict = preview.conflicts[0]!;
      targetId = NodePath.basename(NodePath.dirname(conflict.path));
      expectedCurrent = await fs.readFile(conflict.path, "utf8");
      if (expectedCurrent !== preview.diff.before)
        throw new Error("Destination changed after preview; review a new preview");
    } else {
      throw new Error("Resolve destination conflicts explicitly before applying the scope change");
    }
  } else {
    targetId = `hub-${hash(name.toLocaleLowerCase()).slice(0, 16)}`;
  }
  if (!safeSegment(targetId)) throw new Error("Invalid destination skill identity");
  const transactionId = `scope-${preview.id}`;
  const receipt = await applySkillChange(
    preview.destination.root,
    {
      kind: "write",
      id: targetId,
      name,
      content,
    },
    transactionId,
    expectedCurrent,
  );
  const entry: SkillScopeHistoryEntry = {
    id: preview.id,
    createdAt,
    source: preview.source,
    destination: { ...preview.destination, name },
    receipt,
  };
  try {
    await fs.writeFile(historyFile, JSON.stringify(entry), { flag: "wx", mode: 0o600 });
    await commitSkillChange(preview.destination.root, receipt);
  } catch (error) {
    await rollbackSkillChange(preview.destination.root, receipt).catch(() => undefined);
    await fs.rm(historyFile, { force: true }).catch(() => undefined);
    throw error;
  }
  return entry;
}

export async function listSkillScopeHistory(
  destinationRoot: string,
): Promise<ReadonlyArray<SkillScopeHistoryEntry>> {
  const directory = await historyRoot(destinationRoot, false);
  const names = await fs.readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const entries: SkillScopeHistoryEntry[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    const file = NodePath.join(directory, name);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe skill history entry");
    entries.push(JSON.parse(await fs.readFile(file, "utf8")) as SkillScopeHistoryEntry);
  }
  return entries;
}

/** Roll back a scope copy without touching its original source. */
export async function rollbackSkillScopeChange(
  destinationRoot: string,
  entryId: string,
): Promise<void> {
  if (!safeSegment(entryId)) throw new Error("Invalid scope history id");
  const root = assertNativeSkillsRoot(destinationRoot);
  const directory = await historyRoot(root, false);
  const file = NodePath.join(directory, `${entryId}.json`);
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe skill history entry");
  const entry = JSON.parse(await fs.readFile(file, "utf8")) as SkillScopeHistoryEntry;
  if (entry.id !== entryId || NodePath.dirname(NodePath.resolve(entry.receipt.target)) !== root)
    throw new Error("Skill history entry does not match its destination");
  await rollbackSkillChange(root, entry.receipt);
  await fs.rm(file);
}
