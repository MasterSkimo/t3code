import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../test/render";

const state = vi.hoisted(() => ({
  proposals: [] as Array<Record<string, unknown>>,
  resources: [] as Array<Record<string, unknown>>,
  deployments: [] as Array<Record<string, unknown>>,
  canOperate: false,
}));

vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: (() => "env-1") as never,
  useEnvironments: (() => ({
    isReady: true,
    networkStatus: { _tag: "Online" },
    environments: [{ environmentId: "env-1", label: "Test environment" }],
    presentationById: new Map(),
  })) as never,
}));
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: () => [],
}));
vi.mock(import("../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => state.canOperate,
}));
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      harnessProposals: () => ({ kind: "proposals" }),
      harnessHubResources: () => ({ kind: "resources" }),
      harnessScopeHistory: () => ({ kind: "history" }),
      harnessMcpDeployments: () => ({ kind: "deployments" }),
      approveHarnessProposal: "approve",
      reviseHarnessProposal: "revise",
      rejectHarnessProposal: "reject",
      applyHarnessProposal: "apply",
      rollbackHarnessProposal: "rollback",
      previewHarnessScope: "preview-scope",
      applyHarnessScope: "apply-scope",
      rollbackHarnessScope: "rollback-scope",
      previewHarnessMcpDistribution: "preview-mcp",
      applyHarnessMcpDistribution: "apply-mcp",
      adoptHarnessMcp: "adopt-mcp",
      untrackHarnessMcp: "untrack-mcp",
    } as never,
  };
});
vi.mock("../state/query", async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (query: { kind?: string } | null) => ({
    data:
      query?.kind === "proposals"
        ? { proposals: state.proposals }
        : query?.kind === "resources"
          ? { resources: state.resources }
          : query?.kind === "deployments"
            ? { deployments: state.deployments }
            : { entries: [] },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(async () => ({ _tag: "Success", value: {} })),
}));

import { HarnessHubPage } from "./HarnessHubPage";

function setup() {
  state.proposals = [
    {
      id: "proposal-1",
      scope: { kind: "global" },
      operation: "update",
      skillName: "review-skill",
      targetSkillIds: ["skill-1"],
      evidence: ["Repeated correction"],
      sourceRefs: [],
      contentDiff: { before: "old instruction", after: "new instruction" },
      engineId: "native-v1",
      engineVersion: "1",
      confidence: 0.9,
      rationale: "This guidance was repeated.",
      status: "pending",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      decidedAt: null,
      decisionNote: null,
      appliedAt: null,
      appliedReceipt: null,
    },
  ];
  state.resources = [
    {
      id: "mcp-1",
      type: "mcp",
      name: "GitLab",
      scope: "global",
      provider: "claude",
      source: "~/.claude/settings.json",
      ownership: "user",
      description: "Configured with sensitive fields; values hidden.",
      status: "installed",
      operations: [],
    },
  ];
  state.deployments = [
    {
      id: "deployment-1",
      sourceResourceId: "mcp-1",
      sourceScope: "global",
      targetProvider: "claude",
      targetScope: "global",
      serverName: "GitLab",
      configurationFingerprint: "redacted-fingerprint",
      trackingOrigin: "adopted",
      trackedAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      drift: "unknown",
    },
  ];
  state.canOperate = false;
}

describe("Harness Hub", () => {
  it("shows a pending proposal and its before/after review while protecting decision actions", async () => {
    setup();
    await using screen = await render(<HarnessHubPage />);

    await expect.element(screen.getByText("review-skill · update")).toBeInTheDocument();
    await userEvent.click(screen.getByText("review-skill · update"));
    await userEvent.click(screen.getByText("Comparer avant / après"));

    await expect.element(screen.getByText("old instruction")).toBeInTheDocument();
    await expect.element(screen.getByText("new instruction")).toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Approuver" })).toBeDisabled();
  });

  it("shows tracked drift separately from unknown authentication and runtime availability", async () => {
    setup();
    await using screen = await render(<HarnessHubPage />);
    await userEvent.click(screen.getByRole("button", { name: "Connexions" }));

    await expect.element(screen.getByText("État inconnu")).toBeInTheDocument();
    await expect.element(screen.getByText("Suivi Harness actif")).toBeInTheDocument();
    await expect
      .element(screen.getByText("Configuré; authentification non vérifiée"))
      .toBeInTheDocument();
    await expect.element(screen.getByText("Disponibilité inconnue")).toBeInTheDocument();
    await expect.element(screen.getByText(/T3 ne lance pas le parcours OAuth/)).toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Arrêter le suivi" })).toBeDisabled();
  });
});
