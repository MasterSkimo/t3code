// @effect-diagnostics nodeBuiltinImport:off -- atomic directory renames and scoped link checks need Node filesystem primitives.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { parse as parseYaml } from "yaml";

const MAX_SKILL_BYTES = 1_000_000;
const MARKER = ".harness-managed.json";
const JOURNAL_DIRECTORY = ".harness-journal";
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export type SkillScope = "project" | "user" | "external" | "harness";

export interface SkillRoot {
  readonly path: string;
  readonly scope: SkillScope;
}

/** Roots supported by the common agent skills convention, plus Harness' private archive. */
export function defaultSkillRoots(projectRoot: string, userHome: string): readonly SkillRoot[] {
  return [
    { path: path.join(projectRoot, ".agents", "skills"), scope: "project" },
    { path: path.join(userHome, ".agents", "skills"), scope: "user" },
  ];
}

export interface DiscoveredSkill {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly content: string;
  readonly path: string;
  readonly scope: SkillScope;
  readonly managed: boolean;
}

export type SkillChange =
  | { readonly kind: "write"; readonly id: string; readonly name: string; readonly content: string }
  | { readonly kind: "archive"; readonly id: string };

export interface SkillChangeReceipt {
  readonly target: string;
  readonly previousContent?: string;
  readonly previousPath?: string;
  readonly appliedHash?: string;
  readonly archivedTo?: string;
  readonly archivedSources?: ReadonlyArray<{
    readonly target: string;
    readonly archivedTo: string;
    readonly contentHash: string;
  }>;
  readonly transactionId?: string;
  readonly change: SkillChange;
}

const fs = NodeFS.promises;
const path = NodePath;
const randomUUID = NodeCrypto.randomUUID;
const hash = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const safeSegment = (value: string) =>
  value.length > 0 && value !== "." && value !== ".." && /^[\p{L}\p{N}._-]+$/u.test(value);

function metadata(content: string, fallbackName: string) {
  const match = FRONTMATTER.exec(content);
  if (!match) return { name: fallbackName };
  try {
    const parsed: unknown = parseYaml(match[1] ?? "");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return { name: fallbackName };
    const record = parsed as Record<string, unknown>;
    const name =
      typeof record.name === "string" && record.name.trim() ? record.name.trim() : fallbackName;
    const description = typeof record.description === "string" ? record.description.trim() : "";
    return { name, ...(description ? { description } : {}) };
  } catch {
    return { name: fallbackName };
  }
}

async function readSkill(root: SkillRoot, directory: string): Promise<DiscoveredSkill | undefined> {
  const skillPath = path.join(directory, "SKILL.md");
  try {
    const stat = await fs.lstat(skillPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SKILL_BYTES) return undefined;
    const content = await fs.readFile(skillPath, "utf8");
    const dirname = path.basename(directory);
    const details = metadata(content, dirname);
    let managed = false;
    try {
      const marker = JSON.parse(await fs.readFile(path.join(directory, MARKER), "utf8")) as {
        hash?: unknown;
        hashes?: unknown;
      };
      const contentHash = hash(content);
      managed =
        marker.hash === contentHash ||
        (Array.isArray(marker.hashes) && marker.hashes.includes(contentHash));
    } catch {
      // A readable skill without our integrity marker is user-owned.
    }
    return {
      id: `${root.scope}:${hash(`${path.resolve(directory)}\0${content}`).slice(0, 24)}`,
      name: details.name,
      ...(details.description ? { description: details.description } : {}),
      content,
      path: skillPath,
      scope: root.scope,
      managed,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Read skills from explicit roots. Directory symlinks are ignored, and roots are never mutated. */
export async function discoverSkills(
  roots: readonly SkillRoot[],
): Promise<readonly DiscoveredSkill[]> {
  const discovered: DiscoveredSkill[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = await fs.readdir(root.path);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "ENOENT" ||
        (error as NodeJS.ErrnoException).code === "ENOTDIR"
      )
        continue;
      throw error;
    }
    for (const entry of entries.sort()) {
      if (!safeSegment(entry)) continue;
      const directory = path.join(root.path, entry);
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      const skill = await readSkill(root, directory);
      if (skill) discovered.push(skill);
    }
  }
  return discovered;
}

async function assertSafeRoot(root: string): Promise<string> {
  const absolute = path.resolve(root);
  const parentReal = await fs.realpath(path.dirname(absolute));
  const stat = await fs.lstat(absolute).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (stat?.isSymbolicLink() || (stat && !stat.isDirectory()))
    throw new Error("Harness skill root must be a real directory");
  if (stat && (await fs.realpath(absolute)) !== absolute)
    throw new Error("Harness skill root resolves through a symlink");
  return path.join(parentReal, path.basename(absolute));
}

async function loadOwnedSkill(
  target: string,
): Promise<{ content: string; hash: string } | undefined> {
  let dirStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    dirStat = await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink())
    throw new Error("Refusing to modify a non-directory skill path");
  try {
    const markerPath = path.join(target, MARKER);
    const markerStat = await fs.lstat(markerPath);
    if (!markerStat.isFile() || markerStat.isSymbolicLink())
      throw new Error("Refusing to modify an unmanaged skill");
    const marker = JSON.parse(await fs.readFile(markerPath, "utf8")) as { hash?: unknown };
    const skillPath = path.join(target, "SKILL.md");
    const skillStat = await fs.lstat(skillPath);
    if (!skillStat.isFile() || skillStat.isSymbolicLink())
      throw new Error("Refusing to modify an unsafe skill file");
    const content = await fs.readFile(skillPath, "utf8");
    if (marker.hash !== hash(content)) {
      throw new Error(
        "Managed skill changed since Harness applied it; refusing to overwrite external edits",
      );
    }
    return { content, hash: hash(content) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Refusing to modify an unmanaged skill", { cause: error });
    }
    throw error;
  }
}

async function assertPrivateDirectory(directory: string, root: string): Promise<void> {
  const info = await fs.lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await fs.realpath(directory)) !== directory
  ) {
    throw new Error("Harness private directory must not be a symlink");
  }
  if (path.dirname(directory) !== root)
    throw new Error("Harness private directory escaped its managed root");
}

async function writeFileAtomically(target: string, contents: string): Promise<void> {
  const info = await fs.lstat(target);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("Refusing to replace an unsafe skill file");
  const staged = path.join(path.dirname(target), `.harness-write-${randomUUID()}`);
  await fs.writeFile(staged, contents, { flag: "wx" });
  try {
    await fs.rename(staged, target);
  } catch (error) {
    await fs.rm(staged, { force: true });
    throw error;
  }
}

const writeManagedMarker = (directory: string, marker: unknown) =>
  writeFileAtomically(path.join(directory, MARKER), JSON.stringify(marker));

async function privateJournalDirectory(root: string): Promise<string> {
  const directory = path.join(root, JOURNAL_DIRECTORY);
  const info = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return directory;
  await assertPrivateDirectory(directory, root);
  return directory;
}

async function readJournal(root: string, transactionId: string): Promise<SkillChangeReceipt> {
  if (!safeSegment(transactionId)) throw new Error("Invalid Harness transaction id");
  const directory = await privateJournalDirectory(root);
  const file = path.join(directory, `${transactionId}.json`);
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SKILL_BYTES * 2) {
    throw new Error("Harness recovery journal is not a safe file");
  }
  const receipt = JSON.parse(await fs.readFile(file, "utf8")) as SkillChangeReceipt;
  if (receipt.transactionId !== transactionId)
    throw new Error("Harness recovery journal does not match its transaction");
  return receipt;
}

async function removeJournal(root: string, transactionId: string | undefined): Promise<void> {
  if (!transactionId) return;
  if (!safeSegment(transactionId)) throw new Error("Invalid Harness transaction id");
  const directory = await privateJournalDirectory(root);
  const file = path.join(directory, `${transactionId}.json`);
  const info = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return;
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("Harness recovery journal is not a safe file");
  await fs.rm(file);
}

/** Mark a successfully persisted application complete by removing its recovery record. */
export async function commitSkillChange(
  managedRoot: string,
  receipt: SkillChangeReceipt,
): Promise<void> {
  const root = await assertSafeRoot(managedRoot);
  const target = path.resolve(receipt.target);
  if (path.dirname(target) !== root || path.basename(target) !== receipt.change.id) {
    throw new Error("Skill receipt is outside the managed root");
  }
  let journal: SkillChangeReceipt | undefined;
  if (receipt.transactionId) {
    journal = await readJournal(root, receipt.transactionId).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
  }
  if (
    journal &&
    (journal.target !== receipt.target ||
      journal.previousContent !== receipt.previousContent ||
      journal.previousPath !== receipt.previousPath ||
      journal.appliedHash !== receipt.appliedHash ||
      journal.archivedTo !== receipt.archivedTo ||
      journal.transactionId !== receipt.transactionId ||
      JSON.stringify(journal.change) !== JSON.stringify(receipt.change) ||
      JSON.stringify(journal.archivedSources ?? []) !==
        JSON.stringify(receipt.archivedSources ?? []))
  ) {
    throw new Error("Harness recovery journal changed before commit");
  }
  if (receipt.previousPath) {
    const backup = path.resolve(receipt.previousPath);
    if (path.dirname(backup) !== root || !path.basename(backup).startsWith(".previous-")) {
      throw new Error("Invalid previous skill backup path");
    }
    const info = await fs.lstat(backup).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (info) {
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("Previous skill backup is not a safe directory");
      await fs.rm(backup, { recursive: true });
    }
  }
  await removeJournal(root, receipt.transactionId);
}

/** Recover an interrupted apply after restart using its pre-mutation journal. */
export async function recoverSkillChange(
  managedRoot: string,
  transactionId: string,
): Promise<void> {
  const root = await assertSafeRoot(managedRoot);
  const receipt = await readJournal(root, transactionId).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!receipt) return;
  await rollbackSkillChange(root, receipt);
}

/** Roll back only if the applied version is still intact; external edits are preserved. */
export async function rollbackSkillChange(
  managedRoot: string,
  receipt: SkillChangeReceipt,
): Promise<void> {
  const root = await assertSafeRoot(managedRoot);
  const target = path.resolve(receipt.target);
  if (path.dirname(target) !== root || !safeSegment(path.basename(target))) {
    throw new Error("Skill receipt is outside the managed root");
  }
  if (receipt.change.id !== path.basename(target))
    throw new Error("Skill receipt does not match its target");
  const previousPath =
    receipt.previousPath === undefined ? undefined : path.resolve(receipt.previousPath);
  if (
    previousPath &&
    (path.dirname(previousPath) !== root || !path.basename(previousPath).startsWith(".previous-"))
  ) {
    throw new Error("Invalid previous skill backup path");
  }
  if (receipt.archivedTo) {
    const archive = path.resolve(receipt.archivedTo);
    const archiveRoot = path.join(root, ".archive");
    if (path.dirname(archive) !== archiveRoot || !safeSegment(path.basename(archive)))
      throw new Error("Invalid archive receipt");
    if (!path.basename(archive).startsWith(`${path.basename(target)}-`))
      throw new Error("Archive receipt does not match its target");
    await assertPrivateDirectory(archiveRoot, root);
    const archived = await loadOwnedSkill(archive);
    if (!archived) {
      const restored = await loadOwnedSkill(target);
      if (restored) {
        await removeJournal(root, receipt.transactionId);
        return;
      }
      throw new Error("Archived skill is missing or no longer Harness-managed");
    }
    await fs
      .lstat(target)
      .then(() => {
        throw new Error("Cannot restore archive over an existing skill");
      })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    await fs.rename(archive, target);
    await removeJournal(root, receipt.transactionId);
    return;
  }
  for (const source of [...(receipt.archivedSources ?? [])].reverse()) {
    const sourceTarget = path.resolve(source.target);
    const sourceArchive = path.resolve(source.archivedTo);
    if (
      path.dirname(sourceTarget) !== root ||
      !safeSegment(path.basename(sourceTarget)) ||
      path.dirname(sourceArchive) !== path.join(root, ".archive") ||
      !path.basename(sourceArchive).startsWith(`${path.basename(sourceTarget)}-`)
    ) {
      throw new Error("Invalid merged skill archive receipt");
    }
    const archived = await loadOwnedSkill(sourceArchive);
    if (archived) {
      if (hash(archived.content) !== source.contentHash)
        throw new Error("Merged source archive changed after apply");
      await fs
        .lstat(sourceTarget)
        .then(() => {
          throw new Error("Cannot restore a merged source over an existing skill");
        })
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      await fs.rename(sourceArchive, sourceTarget);
      continue;
    }
    const restoredSource = await loadOwnedSkill(sourceTarget);
    if (!restoredSource || hash(restoredSource.content) !== source.contentHash) {
      throw new Error("Merged source archive is missing or no longer Harness-managed");
    }
  }
  let current: { content: string; hash: string } | undefined;
  try {
    current = await loadOwnedSkill(target);
  } catch (error) {
    if (
      receipt.previousContent === undefined &&
      receipt.change.kind === "write" &&
      error instanceof Error &&
      error.message === "Refusing to modify an unmanaged skill"
    ) {
      await removeJournal(root, receipt.transactionId);
      return;
    }
    throw error;
  }
  if (previousPath) {
    const previousInfo = await fs.lstat(previousPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (previousInfo && (!previousInfo.isDirectory() || previousInfo.isSymbolicLink())) {
      throw new Error("Previous skill backup is not a safe directory");
    }
    if (previousInfo && !current) {
      const previous = await loadOwnedSkill(previousPath);
      if (!previous || previous.content !== receipt.previousContent)
        throw new Error("Previous skill backup no longer matches the recovery receipt");
      await fs.rename(previousPath, target);
      await removeJournal(root, receipt.transactionId);
      return;
    }
    if (previousInfo && current?.hash === receipt.appliedHash) {
      const previous = await loadOwnedSkill(previousPath);
      if (!previous || previous.content !== receipt.previousContent)
        throw new Error("Previous skill backup no longer matches the recovery receipt");
      await fs.rm(target, { recursive: true });
      await fs.rename(previousPath, target);
      await removeJournal(root, receipt.transactionId);
      return;
    }
  }
  if (!current && receipt.previousContent === undefined) {
    await removeJournal(root, receipt.transactionId);
    return;
  }
  if (
    current &&
    receipt.previousContent !== undefined &&
    current.hash === hash(receipt.previousContent)
  ) {
    await writeManagedMarker(target, { hash: current.hash });
    if (previousPath) await fs.rm(previousPath, { recursive: true, force: true });
    await removeJournal(root, receipt.transactionId);
    return;
  }
  if (!current || !receipt.appliedHash || current.hash !== receipt.appliedHash) {
    throw new Error("Cannot roll back a skill that has changed since Harness applied it");
  }
  if (receipt.previousContent === undefined) {
    await fs.rm(target, { recursive: true });
    await removeJournal(root, receipt.transactionId);
    return;
  }
  if (receipt.change.kind !== "write") throw new Error("Invalid skill rollback receipt");
  const previousHash = hash(receipt.previousContent);
  await writeManagedMarker(target, { hashes: [current.hash, previousHash] });
  const skillFile = path.join(target, "SKILL.md");
  const skillInfo = await fs.lstat(skillFile);
  if (!skillInfo.isFile() || skillInfo.isSymbolicLink())
    throw new Error("Refusing to restore an unsafe skill file");
  const stagedFile = path.join(target, `.harness-write-${randomUUID()}`);
  await fs.writeFile(stagedFile, receipt.previousContent, { flag: "wx" });
  try {
    await fs.rename(stagedFile, skillFile);
  } catch (error) {
    await fs.rm(stagedFile, { force: true });
    throw error;
  }
  await writeManagedMarker(target, { hash: previousHash });
  if (previousPath) await fs.rm(previousPath, { recursive: true, force: true });
  await removeJournal(root, receipt.transactionId);
}
