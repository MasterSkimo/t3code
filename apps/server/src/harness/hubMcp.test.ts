// @effect-diagnostics nodeBuiltinImport:off -- temporary-file tests verify native configuration safety.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

import {
  applyNativeMcpWrite,
  discoverNativeMcp,
  hubMcpFingerprint,
  nativeMcpDrift,
  planNativeMcpWrite,
  type PortableMcpServer,
} from "./hubMcp.ts";

const localServer = {
  transport: "stdio" as const,
  command: "node",
  args: ["server.js"],
  env: { API_TOKEN: "${API_TOKEN}" },
};

describe("Harness native MCP configuration", () => {
  it("discovers strict JSON entries without exposing credentials", () => {
    const config = { command: "node", env: { API_TOKEN: "hidden" } };
    const result = discoverNativeMcp(
      "claude",
      JSON.stringify({
        mcpServers: { gitlab: config, other: { command: "node", args: [] } },
        unrelated: { keep: true },
      }),
    );
    expect("servers" in result).toBe(true);
    if (!("servers" in result)) return;
    expect(result.servers).toHaveLength(2);
    expect(result.servers[0]?.configuration).toEqual({
      command: "node",
      env: { API_TOKEN: "[redacted]" },
    });
    expect(result.servers[0]?.fingerprint).toBe(hubMcpFingerprint(config));
  });

  it("adds a native Claude entry while preserving existing entries and unrelated config", () => {
    const original = JSON.stringify({
      mcpServers: { existing: { command: "keep", env: { PASSWORD: "do-not-touch" } } },
      customSetting: 3,
    });
    const plan = planNativeMcpWrite({
      provider: "claude",
      contents: original,
      expectedFileFingerprint: hubMcpFingerprint(original),
      name: "new-server",
      server: localServer,
    });
    expect(plan.status).toBe("written");
    if (plan.status !== "written") return;
    const saved = JSON.parse(plan.contents);
    expect(saved.mcpServers.existing.env.PASSWORD).toBe("do-not-touch");
    expect(saved.mcpServers["new-server"]).toEqual({
      command: "node",
      args: ["server.js"],
      env: { API_TOKEN: "${API_TOKEN}" },
    });
    expect(saved.customSetting).toBe(3);
  });

  it("supports current and legacy OpenCode MCP locations", () => {
    const current = JSON.stringify({
      mcp: { servers: { old: { type: "remote", url: "https://old" } } },
    });
    const currentPlan = planNativeMcpWrite({
      provider: "opencode",
      contents: current,
      expectedFileFingerprint: hubMcpFingerprint(current),
      name: "new",
      server: localServer,
    });
    expect(currentPlan.status).toBe("written");
    if (currentPlan.status === "written") {
      expect(JSON.parse(currentPlan.contents).mcp.servers.new).toEqual({
        type: "local",
        command: ["node", "server.js"],
        environment: { API_TOKEN: "${API_TOKEN}" },
      });
    }
    const legacy = JSON.stringify({ mcp: { old: { type: "local", command: ["echo"] } } });
    const legacyPlan = planNativeMcpWrite({
      provider: "opencode",
      contents: legacy,
      expectedFileFingerprint: hubMcpFingerprint(legacy),
      name: "new",
      server: localServer,
    });
    expect(legacyPlan.status).toBe("written");
    if (legacyPlan.status === "written")
      expect(JSON.parse(legacyPlan.contents).mcp.new.type).toBe("local");
    const unknown = JSON.stringify({ mcp: {} });
    expect(
      planNativeMcpWrite({
        provider: "opencode",
        contents: unknown,
        expectedFileFingerprint: hubMcpFingerprint(unknown),
        name: "new",
        server: localServer,
      }),
    ).toMatchObject({ status: "unsupported" });
  });

  it("refuses stale previews, name conflicts, raw secrets, JSONC, and Codex TOML", () => {
    const base = { provider: "claude" as const, name: "gitlab", server: localServer };
    expect(
      planNativeMcpWrite({ ...base, contents: "{}", expectedFileFingerprint: "stale" }).status,
    ).toBe("conflict");
    const conflict = JSON.stringify({ mcpServers: { gitlab: { command: "other" } } });
    expect(
      planNativeMcpWrite({
        ...base,
        contents: conflict,
        expectedFileFingerprint: hubMcpFingerprint(conflict),
      }).status,
    ).toBe("conflict");
    expect(
      planNativeMcpWrite({
        ...base,
        server: {
          transport: "http",
          url: "https://example.test/mcp",
          headers: { Authorization: "Bearer leaked" },
        },
        contents: "{}",
        expectedFileFingerprint: hubMcpFingerprint("{}"),
      }).status,
    ).toBe("unsupported");
    const refuse = (server: PortableMcpServer) =>
      planNativeMcpWrite({
        provider: "claude",
        contents: "{}",
        expectedFileFingerprint: hubMcpFingerprint("{}"),
        name: "gitlab",
        server,
      });
    expect(
      refuse({ transport: "stdio", command: "node", args: ["--token=inline-secret"] }).status,
    ).toBe("unsupported");
    expect(
      refuse({
        transport: "stdio",
        command: "node",
        args: ["--header", "Authorization: Bearer abcdefghijklmnop"],
      }).status,
    ).toBe("unsupported");
    expect(
      refuse({
        transport: "http",
        url: "https://user:password@example.test/mcp",
      }).status,
    ).toBe("unsupported");
    expect(
      refuse({
        transport: "http",
        url: "https://example.test/mcp/tokens/opaque-value",
      }).status,
    ).toBe("unsupported");
    expect(
      refuse({
        transport: "http",
        url: "https://example.test/mcp/0123456789abcdef0123456789abcdef0123456789",
      }).status,
    ).toBe("unsupported");
    expect(discoverNativeMcp("claude", '{ // comment\n "mcpServers": {} }')).toHaveProperty(
      "unsupported",
    );
    expect(discoverNativeMcp("codex", "[mcp_servers]")).toHaveProperty("unsupported");
  });

  it("detects drift from the last applied native entry fingerprint", () => {
    const applied = { type: "local", command: ["node", "server.js"] };
    expect(nativeMcpDrift(hubMcpFingerprint(applied), applied)).toBe("synchronized");
    expect(nativeMcpDrift(hubMcpFingerprint(applied), { ...applied, enabled: false })).toBe(
      "drifted",
    );
    expect(nativeMcpDrift(hubMcpFingerprint(applied), undefined)).toBe("missing");
  });

  it("writes a guarded update and refuses stale state", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hub-mcp-"));
    try {
      const filePath = NodePath.join(directory, ".mcp.json");
      const original = JSON.stringify({ mcpServers: { keep: { command: "keep" } } });
      await NodeFSP.writeFile(filePath, original, { mode: 0o600 });
      const result = await applyNativeMcpWrite({
        filePath,
        provider: "claude",
        expectedFileFingerprint: hubMcpFingerprint(original),
        name: "new",
        server: localServer,
      });
      expect(result.status).toBe("written");
      expect(JSON.parse(await NodeFSP.readFile(filePath, "utf8")).mcpServers.keep.command).toBe(
        "keep",
      );
      const stale = await applyNativeMcpWrite({
        filePath,
        provider: "claude",
        expectedFileFingerprint: hubMcpFingerprint(original),
        name: "another",
        server: localServer,
      });
      expect(stale.status).toBe("conflict");

      const missingPath = NodePath.join(directory, "new.mcp.json");
      const created = await applyNativeMcpWrite({
        filePath: missingPath,
        provider: "claude",
        expectedFileFingerprint: "missing",
        name: "first",
        server: localServer,
      });
      expect(created.status).toBe("written");
      expect(JSON.parse(await NodeFSP.readFile(missingPath, "utf8")).mcpServers.first.command).toBe(
        "node",
      );
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("serializes concurrent Harness writes and rejects symlinked parent directories", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hub-mcp-lock-"));
    try {
      const filePath = NodePath.join(directory, "config.json");
      const fingerprint = "missing";
      const write = (name: string) =>
        applyNativeMcpWrite({
          filePath,
          provider: "claude",
          expectedFileFingerprint: fingerprint,
          name,
          server: { transport: "stdio", command: "node", args: [] },
        });
      const results = await Promise.all([write("one"), write("two")]);
      expect(results.map((result) => result.status).sort()).toEqual(["conflict", "written"]);

      if (!symlinksSupported) return;
      const link = NodePath.join(directory, "linked");
      await NodeFSP.symlink(directory, link, "dir");
      const throughLink = await applyNativeMcpWrite({
        filePath: NodePath.join(link, "linked.json"),
        provider: "claude",
        expectedFileFingerprint: "missing",
        name: "blocked",
        server: { transport: "stdio", command: "node", args: [] },
      });
      expect(throughLink.status).toBe("unsupported");
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});
