// @effect-diagnostics nodeBuiltinImport:off -- filesystem lifecycle tests need temporary dirs and symlinks.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it } from "@effect/vitest";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

import {
  applySkillChange,
  applySkillMerge,
  commitSkillChange,
  defaultSkillRoots,
  discoverSkills,
  recoverSkillChange,
  rollbackSkillChange,
} from "./skills.ts";

async function withTempDirectory(run: (directory: string) => Promise<void>) {
  const directory = await NodeFS.promises.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "t3-harness-skills-"),
  );
  try {
    await run(directory);
  } finally {
    await NodeFS.promises.rm(directory, { recursive: true, force: true });
  }
}

it("discovers project and global skills without treating ordinary skills as managed", async () => {
  await withTempDirectory(async (directory) => {
    const project = NodePath.join(directory, "project");
    const home = NodePath.join(directory, "home");
    const projectSkill = NodePath.join(project, ".agents", "skills", "lint");
    const globalSkill = NodePath.join(home, ".agents", "skills", "review");
    await NodeFS.promises.mkdir(projectSkill, { recursive: true });
    await NodeFS.promises.mkdir(globalSkill, { recursive: true });
    await NodeFS.promises.writeFile(
      NodePath.join(projectSkill, "SKILL.md"),
      "---\nname: lint\ndescription: Lint code\n---\nProject instructions",
    );
    await NodeFS.promises.writeFile(
      NodePath.join(globalSkill, "SKILL.md"),
      "---\nname: review\n---\nGlobal instructions",
    );

    const skills = await discoverSkills(defaultSkillRoots(project, home));
    NodeAssert.deepEqual(
      skills.map(({ name, scope, managed }) => [name, scope, managed]),
      [
        ["lint", "project", false],
        ["review", "user", false],
      ],
    );
  });
});

it("applies and rolls back an update atomically, preserving the previous managed version", async () => {
  await withTempDirectory(async (directory) => {
    const root = NodePath.join(directory, ".agents", "skills");
    const original = "---\nname: summarize\n---\nOriginal";
    const first = await applySkillChange(root, {
      kind: "write",
      id: "summarize",
      name: "summarize",
      content: original,
    });
    NodeAssert.equal(first.previousContent, undefined);

    const updated = "---\nname: summarize\n---\nUpdated";
    const receipt = await applySkillChange(root, {
      kind: "write",
      id: "summarize",
      name: "summarize",
      content: updated,
    });
    NodeAssert.equal(receipt.previousContent, original);
    NodeAssert.equal(
      await NodeFS.promises.readFile(NodePath.join(root, "summarize", "SKILL.md"), "utf8"),
      updated,
    );
    await rollbackSkillChange(root, receipt);
    NodeAssert.equal(
      await NodeFS.promises.readFile(NodePath.join(root, "summarize", "SKILL.md"), "utf8"),
      original,
    );
  });
});

it("refuses to overwrite unmanaged skills and keeps edits made after apply", async () => {
  await withTempDirectory(async (directory) => {
    const root = NodePath.join(directory, ".agents", "skills");
    const unmanaged = NodePath.join(root, "owned-by-user");
    await NodeFS.promises.mkdir(unmanaged, { recursive: true });
    await NodeFS.promises.writeFile(NodePath.join(unmanaged, "SKILL.md"), "User content");
    await NodeAssert.rejects(
      applySkillChange(root, {
        kind: "write",
        id: "owned-by-user",
        name: "owned-by-user",
        content: "Harness",
      }),
      /unmanaged skill/,
    );

    const receipt = await applySkillChange(root, {
      kind: "write",
      id: "harness-skill",
      name: "harness-skill",
      content: "Harness content",
    });
    await NodeFS.promises.writeFile(NodePath.join(root, "harness-skill", "SKILL.md"), "User edit");
    await NodeAssert.rejects(
      rollbackSkillChange(root, receipt),
      /changed since Harness applied it/,
    );
    NodeAssert.equal(
      await NodeFS.promises.readFile(NodePath.join(root, "harness-skill", "SKILL.md"), "utf8"),
      "User edit",
    );
  });
});

it("archives and restores only Harness-owned skills", async () => {
  await withTempDirectory(async (directory) => {
    const root = NodePath.join(directory, ".agents", "skills");
    const content = "---\nname: cleanup\n---\nManaged";
    await applySkillChange(root, { kind: "write", id: "cleanup", name: "cleanup", content });
    const receipt = await applySkillChange(root, { kind: "archive", id: "cleanup" });
    await NodeAssert.rejects(NodeFS.promises.access(NodePath.join(root, "cleanup")));
    await rollbackSkillChange(root, receipt);
    NodeAssert.equal(
      await NodeFS.promises.readFile(NodePath.join(root, "cleanup", "SKILL.md"), "utf8"),
      content,
    );
  });
});

it("recovers an interrupted apply from its durable journal", async () => {
  await withTempDirectory(async (directory) => {
    const root = NodePath.join(directory, ".agents", "skills");
    const original = "---\nname: checklist\n---\nOriginal";
    await applySkillChange(root, {
      kind: "write",
      id: "checklist",
      name: "checklist",
      content: original,
    });
    const receipt = await applySkillChange(
      root,
      {
        kind: "write",
        id: "checklist",
        name: "checklist",
        content: "---\nname: checklist\n---\nUpdated",
      },
      "proposal-update",
    );

    await recoverSkillChange(root, "proposal-update");
    await rollbackSkillChange(root, receipt);
    NodeAssert.equal(
      await NodeFS.promises.readFile(NodePath.join(root, "checklist", "SKILL.md"), "utf8"),
      original,
    );
    await NodeAssert.rejects(
      NodeFS.promises.access(NodePath.join(root, ".harness-journal", "proposal-update.json")),
    );
  });
});

it("rejects symlink roots and skill folders without touching their targets", async () => {
  if (!symlinksSupported) return;
  await withTempDirectory(async (directory) => {
    const outside = NodePath.join(directory, "outside");
    const outsideSkill = NodePath.join(outside, "untouched");
    await NodeFS.promises.mkdir(outsideSkill, { recursive: true });
    await NodeFS.promises.writeFile(NodePath.join(outsideSkill, "SKILL.md"), "User content");
    const root = NodePath.join(directory, ".agents", "skills");
    await NodeFS.promises.mkdir(NodePath.dirname(root), { recursive: true });
    await NodeFS.promises.symlink(outside, root, "dir");
    await NodeAssert.rejects(
      applySkillChange(root, { kind: "write", id: "created", name: "created", content: "Harness" }),
      /real directory|symlink/,
    );
    await NodeAssert.rejects(
      applySkillChange(outside, {
        kind: "write",
        id: "untouched",
        name: "untouched",
        content: "Harness",
      }),
      /unmanaged skill/,
    );
    NodeAssert.equal(
      await NodeFS.promises.readFile(NodePath.join(outsideSkill, "SKILL.md"), "utf8"),
      "User content",
    );
  });
});

it("merges managed skills, preserves assets, archives sources, and supports rollback", async () => {
  await withTempDirectory(async (directory) => {
    const root = NodePath.join(directory, ".agents", "skills");
    const main = "---\nname: main\n---\nMain instructions";
    const source = "---\nname: source\n---\nSource instructions";
    await applySkillChange(root, { kind: "write", id: "main", name: "main", content: main });
    await applySkillChange(root, { kind: "write", id: "source", name: "source", content: source });
    const mainAsset = NodePath.join(root, "main", "scripts", "run.sh");
    const sourceAsset = NodePath.join(root, "source", "references", "notes.md");
    await NodeFS.promises.mkdir(NodePath.dirname(mainAsset), { recursive: true });
    await NodeFS.promises.mkdir(NodePath.dirname(sourceAsset), { recursive: true });
    await NodeFS.promises.writeFile(mainAsset, "echo main");
    await NodeFS.promises.writeFile(sourceAsset, "source notes");

    const merged = "---\nname: main\n---\nConsolidated instructions";
    const receipt = await applySkillMerge(
      root,
      [
        { id: "main", content: main },
        { id: "source", content: source },
      ],
      "main",
      merged,
      "merge-proposal",
    );
    NodeAssert.equal(
      await NodeFS.promises.readFile(NodePath.join(root, "main", "SKILL.md"), "utf8"),
      merged,
    );
    NodeAssert.equal(
      await NodeFS.promises.readFile(NodePath.join(root, "main", "scripts", "run.sh"), "utf8"),
      "echo main",
    );
    const sourceArchive = receipt.archivedSources?.[0]?.archivedTo;
    NodeAssert.ok(sourceArchive);
    NodeAssert.equal(
      await NodeFS.promises.readFile(
        NodePath.join(sourceArchive, "references", "notes.md"),
        "utf8",
      ),
      "source notes",
    );
    await commitSkillChange(root, receipt);

    await rollbackSkillChange(root, receipt);
    NodeAssert.equal(
      await NodeFS.promises.readFile(NodePath.join(root, "main", "SKILL.md"), "utf8"),
      main,
    );
    NodeAssert.equal(await NodeFS.promises.readFile(mainAsset, "utf8"), "echo main");
    NodeAssert.equal(await NodeFS.promises.readFile(sourceAsset, "utf8"), "source notes");
  });
});
