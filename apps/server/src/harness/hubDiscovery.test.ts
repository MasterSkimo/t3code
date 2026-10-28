// @effect-diagnostics nodeBuiltinImport:off -- discovery tests use isolated temporary files.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it } from "@effect/vitest";

import { discoverHarnessHub } from "./hubDiscovery.ts";

async function withTempDirectory(run: (directory: string) => Promise<void>) {
  const directory = await NodeFS.promises.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "t3-harness-hub-"),
  );
  try {
    await run(directory);
  } finally {
    await NodeFS.promises.rm(directory, { recursive: true, force: true });
  }
}

it("discovers project practices and integrations without returning file contents or secrets", async () => {
  await withTempDirectory(async (directory) => {
    const project = NodePath.join(directory, "project");
    const home = NodePath.join(directory, "home");
    await NodeFS.promises.mkdir(NodePath.join(project, ".agents", "skills", "review"), {
      recursive: true,
    });
    await NodeFS.promises.mkdir(NodePath.join(project, ".claude", "agents"), { recursive: true });
    await NodeFS.promises.mkdir(NodePath.join(project, ".claude"), { recursive: true });
    await NodeFS.promises.writeFile(NodePath.join(project, "AGENTS.md"), "private rule body");
    await NodeFS.promises.writeFile(
      NodePath.join(project, ".agents", "skills", "review", "SKILL.md"),
      "skill secret body",
    );
    await NodeFS.promises.writeFile(
      NodePath.join(project, ".claude", "agents", "reviewer.md"),
      "agent secret body",
    );
    await NodeFS.promises.writeFile(
      NodePath.join(project, ".claude", "settings.json"),
      JSON.stringify({
        hooks: { PreToolUse: [{ command: "echo hook-secret" }] },
        mcpServers: { local: { command: "run-secret", env: { API_TOKEN: "never-return-this" } } },
      }),
    );

    const result = await discoverHarnessHub({
      workspaceRoot: project,
      homeDirectory: home,
      projectId: "project-1",
    });
    const serialized = JSON.stringify(result);
    NodeAssert.match(serialized, /AGENTS\.md/);
    NodeAssert.match(serialized, /reviewer/);
    NodeAssert.match(serialized, /local/);
    NodeAssert.match(serialized, /PreToolUse/);
    NodeAssert.doesNotMatch(
      serialized,
      /private rule body|skill secret body|agent secret body|echo hook-secret|run-secret|never-return-this/,
    );
    NodeAssert.ok(
      result.every((entry) => !entry.source.startsWith("/") && entry.operations.length === 0),
    );
    NodeAssert.ok(
      result
        .filter((entry) => entry.scope === "project")
        .every((entry) => entry.projectId === "project-1"),
    );
  });
});

it("reports malformed known configuration as unknown without exposing its contents", async () => {
  await withTempDirectory(async (directory) => {
    const project = NodePath.join(directory, "project");
    const config = NodePath.join(project, ".mcp.json");
    await NodeFS.promises.mkdir(project, { recursive: true });
    await NodeFS.promises.writeFile(config, "not json; token=must-not-leak");
    const result = await discoverHarnessHub({
      workspaceRoot: project,
      homeDirectory: NodePath.join(directory, "home"),
    });
    const item = result.find((entry) => entry.type === "mcp");
    NodeAssert.ok(item);
    NodeAssert.equal(item.status, "unknown");
    NodeAssert.equal(item.ownership, "unknown");
    NodeAssert.doesNotMatch(JSON.stringify(item), /must-not-leak|not json/);
  });
});

it("discovers OpenCode v2 and legacy server maps without mistaking the wrapper for a server", async () => {
  await withTempDirectory(async (directory) => {
    const project = NodePath.join(directory, "project");
    const config = NodePath.join(project, "opencode.json");
    await NodeFS.promises.mkdir(project, { recursive: true });
    await NodeFS.promises.writeFile(
      config,
      JSON.stringify({
        mcp: {
          servers: {
            docs: {
              type: "remote",
              url: "https://example.test/mcp",
              headers: { Authorization: "hidden" },
            },
          },
        },
      }),
    );
    const v2 = await discoverHarnessHub({
      workspaceRoot: project,
      homeDirectory: NodePath.join(directory, "home"),
    });
    NodeAssert.deepEqual(
      v2.filter((entry) => entry.type === "mcp").map((entry) => entry.name),
      ["docs"],
    );
    NodeAssert.doesNotMatch(JSON.stringify(v2), /example\.test|Authorization|hidden/);

    await NodeFS.promises.writeFile(
      config,
      JSON.stringify({
        mcp: { legacyDocs: { type: "local", command: "run-hidden" } },
      }),
    );
    const legacy = await discoverHarnessHub({
      workspaceRoot: project,
      homeDirectory: NodePath.join(directory, "home"),
    });
    NodeAssert.deepEqual(
      legacy.filter((entry) => entry.type === "mcp").map((entry) => entry.name),
      ["legacyDocs"],
    );

    await NodeFS.promises.writeFile(config, JSON.stringify({ mcp: { enabled: true } }));
    const ambiguous = await discoverHarnessHub({
      workspaceRoot: project,
      homeDirectory: NodePath.join(directory, "home"),
    });
    const unknown = ambiguous.find((entry) => entry.type === "mcp");
    NodeAssert.ok(unknown);
    NodeAssert.equal(unknown.status, "unknown");
    NodeAssert.equal(unknown.name, "MCP configuration");
  });
});
