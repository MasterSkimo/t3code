// @effect-diagnostics nodeBuiltinImport:off -- scope lifecycle tests use isolated filesystem fixtures.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it } from "@effect/vitest";

import { applySkillChange, discoverSkills } from "./skills.ts";
import {
  applySkillScopeChange,
  listSkillScopeHistory,
  previewSkillScopeChange,
  recoverSkillScopeChanges,
  rollbackSkillScopeChange,
} from "./hubScope.ts";

const original = "---\nname: formatter\n---\nKeep formatting consistent.\n";

async function withTempDirectory(run: (directory: string) => Promise<void>) {
  const directory = await NodeFS.promises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-hub-scope-"));
  try {
    await run(directory);
  } finally {
    await NodeFS.promises.rm(directory, { recursive: true, force: true });
  }
}

async function projectSkill(root: string) {
  const directory = NodePath.join(root, "formatter");
  await NodeFS.promises.mkdir(directory, { recursive: true });
  await NodeFS.promises.writeFile(NodePath.join(directory, "SKILL.md"), original);
  return (await discoverSkills([{ path: root, scope: "project" }]))[0]!;
}

it("requires the preview confirmation and rolls back a global copy while preserving its project source", async () => {
  await withTempDirectory(async (directory) => {
    const projectRoot = NodePath.join(directory, "project", ".agents", "skills");
    const globalRoot = NodePath.join(directory, "home", ".agents", "skills");
    const source = await projectSkill(projectRoot);
    const preview = await previewSkillScopeChange(source, globalRoot, "global");
    await NodeAssert.rejects(
      applySkillScopeChange(preview, "", "2026-01-01T00:00:00.000Z"),
      /Explicit confirmation/,
    );
    const entry = await applySkillScopeChange(
      preview,
      preview.confirmationToken,
      "2026-01-01T00:00:00.000Z",
    );
    NodeAssert.equal(entry.source.path, source.path);
    NodeAssert.equal(
      await NodeFS.promises.readFile(
        NodePath.join(globalRoot, NodePath.basename(entry.receipt.target), "SKILL.md"),
        "utf8",
      ),
      original,
    );
    NodeAssert.equal(await NodeFS.promises.readFile(source.path, "utf8"), original);
    NodeAssert.equal((await listSkillScopeHistory(globalRoot)).length, 1);
    await rollbackSkillScopeChange(globalRoot, entry.id);
    NodeAssert.equal((await discoverSkills([{ path: globalRoot, scope: "user" }])).length, 0);
    NodeAssert.equal(await NodeFS.promises.readFile(source.path, "utf8"), original);
  });
});

it("previews destination conflicts and only replaces a managed destination after explicit resolution", async () => {
  await withTempDirectory(async (directory) => {
    const projectRoot = NodePath.join(directory, "project", ".agents", "skills");
    const globalRoot = NodePath.join(directory, "home", ".agents", "skills");
    const source = await projectSkill(projectRoot);
    const changed = "---\nname: formatter\n---\nGlobal version.\n";
    await applySkillChange(globalRoot, {
      kind: "write",
      id: "formatter",
      name: "formatter",
      content: changed,
    });
    const preview = await previewSkillScopeChange(source, globalRoot, "global");
    NodeAssert.equal(preview.conflicts.length, 1);
    NodeAssert.equal(preview.diff.before, changed);
    await NodeAssert.rejects(
      applySkillScopeChange(preview, preview.confirmationToken, "2026-01-01T00:00:00.000Z"),
      /Resolve destination conflicts/,
    );
    const entry = await applySkillScopeChange(
      preview,
      preview.confirmationToken,
      "2026-01-01T00:00:00.000Z",
      "replace-managed",
    );
    NodeAssert.equal(
      await NodeFS.promises.readFile(NodePath.join(globalRoot, "formatter", "SKILL.md"), "utf8"),
      original,
    );
    await rollbackSkillScopeChange(globalRoot, entry.id);
    NodeAssert.equal(
      await NodeFS.promises.readFile(NodePath.join(globalRoot, "formatter", "SKILL.md"), "utf8"),
      changed,
    );
  });
});

it("rejects an altered preview or a source changed after preview", async () => {
  await withTempDirectory(async (directory) => {
    const projectRoot = NodePath.join(directory, "project", ".agents", "skills");
    const source = await projectSkill(projectRoot);
    const preview = await previewSkillScopeChange(
      source,
      NodePath.join(directory, "home", ".agents", "skills"),
      "global",
    );
    await NodeAssert.rejects(
      applySkillScopeChange(
        { ...preview, destination: { ...preview.destination, name: "other" } },
        preview.confirmationToken,
        "2026-01-01T00:00:00.000Z",
      ),
      /review it again/,
    );
    await NodeFS.promises.writeFile(source.path, `${original}Changed`);
    await NodeAssert.rejects(
      applySkillScopeChange(preview, preview.confirmationToken, "2026-01-01T00:00:00.000Z"),
      /changed after preview/,
    );
  });
});

it("does not return credential-shaped content in a preview", async () => {
  await withTempDirectory(async (directory) => {
    const projectRoot = NodePath.join(directory, "project", ".agents", "skills");
    const folder = NodePath.join(projectRoot, "credential-note");
    await NodeFS.promises.mkdir(folder, { recursive: true });
    await NodeFS.promises.writeFile(
      NodePath.join(folder, "SKILL.md"),
      "---\nname: credential-note\n---\napi_key = sk-123456789012345678901234567890\n",
    );
    const source = (await discoverSkills([{ path: projectRoot, scope: "project" }]))[0]!;
    await NodeAssert.rejects(
      previewSkillScopeChange(
        source,
        NodePath.join(directory, "home", ".agents", "skills"),
        "global",
      ),
      /appears to contain credentials/,
    );
  });
});

it("recovers an interrupted scope transaction before history is served", async () => {
  await withTempDirectory(async (directory) => {
    const root = NodePath.join(directory, "home", ".agents", "skills");
    const content = "---\nname: interrupted\n---\nCopy\n";
    await applySkillChange(
      root,
      {
        kind: "write",
        id: "hub-interrupted",
        name: "interrupted",
        content,
      },
      "scope-interrupted-123",
    );
    NodeAssert.equal((await discoverSkills([{ path: root, scope: "user" }])).length, 1);
    await recoverSkillScopeChanges(root);
    NodeAssert.equal((await discoverSkills([{ path: root, scope: "user" }])).length, 0);
  });
});
