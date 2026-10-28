// @effect-diagnostics nodeBuiltinImport:off -- provider fixtures use temporary local directories.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it } from "@effect/vitest";

import { discoverFederatedCatalog } from "./federatedCatalog.ts";

const fs = NodeFS.promises;

async function fixture(run: (root: string, home: string, project: string) => Promise<void>) {
  const root = await fs.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-federated-"));
  const home = NodePath.join(root, "home");
  const project = NodePath.join(root, "project");
  try {
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await run(root, home, project);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function write(root: string, name: string, content: string) {
  const file = NodePath.join(root, name);
  await fs.mkdir(NodePath.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  return file;
}

it("discovers provider skills, commands, rules and agents without exposing source content", async () =>
  fixture(async (_root, home, project) => {
    await write(project, ".cursor/skills/review/SKILL.md", "confidential cursor instruction");
    await write(project, ".cursor/skills/review/assets/template.txt", "asset password=private");
    await write(project, ".claude/agents/reviewer.md", "private agent body");
    await write(home, ".config/opencode/commands/deploy.md", "private deployment command");
    await write(home, ".codex/skills/verify/SKILL.md", "private codex skill");
    await write(project, ".agents/skills/common/SKILL.md", "private shared skill");
    const entries = await discoverFederatedCatalog({
      homeDirectory: home, workspaceRoot: project, projectId: "p",
    });
    for (const [provider, type, name] of [
      ["cursor", "skill", "review"],
      ["claude", "agent", "reviewer"],
      ["opencode", "command", "deploy"],
      ["codex", "skill", "verify"],
      ["shared", "skill", "common"],
    ]) {
      NodeAssert.ok(entries.some((entry) =>
        entry.provider === provider && entry.type === type && entry.name === name),
      `missing ${provider}:${type}:${name}`);
    }
    const serialized = JSON.stringify(entries);
    NodeAssert.doesNotMatch(serialized, /confidential|private|asset password|deployment command/);
    NodeAssert.ok(entries.every((entry) => entry.operations.length === 0));
    NodeAssert.ok(entries.every((entry) => !entry.source.startsWith(home)));
    NodeAssert.ok(entries.every((entry) => !entry.source.startsWith(project)));
    NodeAssert.ok(entries.some((entry) => entry.scope === "project" && entry.projectId === "p"));
    NodeAssert.ok(!entries.some((entry) => entry.name === "template"));
    // The new adapter must not duplicate the legacy shared skill descriptor.
    NodeAssert.equal(entries.filter((entry) => entry.type === "skill" &&
      entry.scope === "project" && entry.name === "common").length, 1);
  }),
);

it("detects identical copies, conflicts and change/deletion across refreshes", async () =>
  fixture(async (_root, home, project) => {
    const projectFile = await write(project, ".cursor/skills/review/SKILL.md", "version 1");
    await write(home, ".cursor/skills/review/SKILL.md", "version 1");
    const input = { homeDirectory: home, workspaceRoot: project, projectId: "p" };
    const initial = (await discoverFederatedCatalog(input)).filter((entry) =>
      entry.provider === "cursor" && entry.type === "skill" && entry.name === "review");
    NodeAssert.equal(initial.length, 2);
    NodeAssert.ok(initial.every((entry) => entry.resolution === "identical-copy"));
    await fs.writeFile(projectFile, "version 2");
    const changed = (await discoverFederatedCatalog(input)).filter((entry) =>
      entry.provider === "cursor" && entry.type === "skill" && entry.name === "review");
    NodeAssert.ok(changed.every((entry) => entry.resolution === "collision-unresolved"));
    NodeAssert.notEqual(initial.find((item) => item.scope === "project")?.fingerprint,
      changed.find((item) => item.scope === "project")?.fingerprint);
    await fs.rm(projectFile);
    const removed = (await discoverFederatedCatalog(input)).filter((entry) =>
      entry.provider === "cursor" && entry.type === "skill" && entry.name === "review");
    NodeAssert.equal(removed.length, 1);
    NodeAssert.equal(removed[0]?.resolution, "unique");
  }),
);

it("respects selected environment and additional local configuration roots", async () =>
  fixture(async (root, home, project) => {
    const codexHome = NodePath.join(root, "custom-codex");
    const opencodeHome = NodePath.join(root, "custom-opencode");
    const extra = NodePath.join(root, "approved-cursor");
    await write(codexHome, "skills/test/SKILL.md", "codex body");
    await write(opencodeHome, "skills/inspect/SKILL.md", "opencode body");
    await write(extra, "rules/private.md", "cursor rule");
    const entries = await discoverFederatedCatalog({
      homeDirectory: home, workspaceRoot: project, projectId: "p",
      environment: { CODEX_HOME: codexHome, OPENCODE_CONFIG_DIR: opencodeHome },
      additionalRoots: [{ provider: "cursor", directory: extra }],
    });
    NodeAssert.ok(entries.some((entry) => entry.provider === "codex" && entry.name === "test"));
    NodeAssert.ok(entries.some((entry) => entry.provider === "opencode" && entry.name === "inspect"));
    NodeAssert.ok(entries.some((entry) => entry.provider === "cursor" && entry.name === "private"));
    NodeAssert.doesNotMatch(JSON.stringify(entries), /approved-cursor|custom-codex|custom-opencode/);
  }),
);

it("does not traverse directory symlinks, oversized files or private skill assets", async () =>
  fixture(async (root, home, project) => {
    const outside = NodePath.join(root, "outside");
    await write(outside, "leak/SKILL.md", "outside private");
    await fs.mkdir(NodePath.join(project, ".cursor", "skills"), { recursive: true });
    await fs.symlink(outside, NodePath.join(project, ".cursor", "skills", "linked"), "dir");
    await write(project, ".cursor/rules/oversized.md", "a".repeat(1_000_001));
    const entries = await discoverFederatedCatalog({
      homeDirectory: home, workspaceRoot: project, projectId: "p",
    });
    NodeAssert.ok(!entries.some((entry) => entry.name === "leak" || entry.name === "oversized"));
    NodeAssert.doesNotMatch(JSON.stringify(entries), /outside private/);
  }),
);

it("reports malformed MCP configuration without leaking environment or commands", async () =>
  fixture(async (_root, home, project) => {
    await write(home, ".cursor/mcp.json", "invalid { token=do-not-leak");
    const entries = await discoverFederatedCatalog({
      homeDirectory: home, workspaceRoot: project, projectId: "p",
    });
    NodeAssert.ok(entries.some((entry) => entry.diagnostics.includes("malformed-config")));
    NodeAssert.doesNotMatch(JSON.stringify(entries), /do-not-leak/);
  }),
);
