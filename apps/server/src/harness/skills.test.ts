// @effect-diagnostics nodeBuiltinImport:off -- filesystem lifecycle tests need temporary dirs.
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it } from "@effect/vitest";

import {
  commitSkillChange,
  defaultSkillRoots,
  discoverSkills,
  recoverSkillChange,
} from "./skills.ts";

const hash = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");

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
      "---\nname: lint\n---\nProject",
    );
    await NodeFS.promises.writeFile(
      NodePath.join(globalSkill, "SKILL.md"),
      "---\nname: review\n---\nGlobal",
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

it("recovers a pre-existing interrupted update from its historical journal and backup", async () => {
  await withTempDirectory(async (directory) => {
    const root = NodePath.join(directory, ".agents", "skills");
    const target = NodePath.join(root, "checklist");
    const previousPath = NodePath.join(root, ".previous-legacy");
    const journalDir = NodePath.join(root, ".harness-journal");
    const previous = "---\nname: checklist\n---\nOriginal";
    const applied = "---\nname: checklist\n---\nUpdated";
    await NodeFS.promises.mkdir(target, { recursive: true });
    await NodeFS.promises.mkdir(previousPath, { recursive: true });
    await NodeFS.promises.mkdir(journalDir, { recursive: true });
    await NodeFS.promises.writeFile(NodePath.join(target, "SKILL.md"), applied);
    await NodeFS.promises.writeFile(
      NodePath.join(target, ".harness-managed.json"),
      JSON.stringify({ hash: hash(applied) }),
    );
    await NodeFS.promises.writeFile(NodePath.join(previousPath, "SKILL.md"), previous);
    await NodeFS.promises.writeFile(
      NodePath.join(previousPath, ".harness-managed.json"),
      JSON.stringify({ hash: hash(previous) }),
    );
    const receipt = {
      target,
      previousContent: previous,
      previousPath,
      appliedHash: hash(applied),
      transactionId: "legacy-update",
      change: { kind: "write", id: "checklist", name: "checklist", content: applied },
    };
    await NodeFS.promises.writeFile(
      NodePath.join(journalDir, "legacy-update.json"),
      JSON.stringify(receipt),
    );

    await recoverSkillChange(root, "legacy-update");
    NodeAssert.equal(
      await NodeFS.promises.readFile(NodePath.join(target, "SKILL.md"), "utf8"),
      previous,
    );
    await NodeAssert.rejects(NodeFS.promises.access(previousPath));
    await NodeAssert.rejects(
      NodeFS.promises.access(NodePath.join(journalDir, "legacy-update.json")),
    );
  });
});

it("commits a historical receipt by removing only its backup and recovery journal", async () => {
  await withTempDirectory(async (directory) => {
    const root = NodePath.join(directory, ".agents", "skills");
    const target = NodePath.join(root, "checklist");
    const previousPath = NodePath.join(root, ".previous-legacy");
    const journalDir = NodePath.join(root, ".harness-journal");
    const content = "---\nname: checklist\n---\nCurrent";
    const previous = "---\nname: checklist\n---\nPrevious";
    await NodeFS.promises.mkdir(target, { recursive: true });
    await NodeFS.promises.mkdir(previousPath, { recursive: true });
    await NodeFS.promises.mkdir(journalDir, { recursive: true });
    await NodeFS.promises.writeFile(NodePath.join(target, "SKILL.md"), content);
    await NodeFS.promises.writeFile(NodePath.join(previousPath, "SKILL.md"), previous);
    const receipt = {
      target,
      previousContent: previous,
      previousPath,
      appliedHash: hash(content),
      transactionId: "legacy-commit",
      change: { kind: "write" as const, id: "checklist", name: "checklist", content },
    };
    await NodeFS.promises.writeFile(
      NodePath.join(journalDir, "legacy-commit.json"),
      JSON.stringify(receipt),
    );

    await commitSkillChange(root, receipt);
    NodeAssert.equal(
      await NodeFS.promises.readFile(NodePath.join(target, "SKILL.md"), "utf8"),
      content,
    );
    await NodeAssert.rejects(NodeFS.promises.access(previousPath));
    await NodeAssert.rejects(
      NodeFS.promises.access(NodePath.join(journalDir, "legacy-commit.json")),
    );
  });
});
