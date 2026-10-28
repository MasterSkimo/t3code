import {
  AuthOrchestrationOperateScope,
  HarnessHubResource,
  type EnvironmentId,
  type HarnessHubScopePreviewResult,
  type HarnessMcpDistributionPreviewResult,
  type HarnessProposal,
} from "@t3tools/contracts";
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { BookOpenIcon, CircleAlertIcon, Link2Icon, SearchIcon, Settings2Icon } from "lucide-react";
import { Button } from "./ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./ui/input-group";
import { Textarea } from "./ui/textarea";
import { useProjects } from "../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { useEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { WorkspacePageContainer } from "./WorkspacePageContainer";

type HubView = "inbox" | "library" | "connections";
type ScopeMode = "effective" | "project" | "global";
type HubResource = typeof HarnessHubResource.Type;

const VIEWS: ReadonlyArray<{ id: HubView; label: string }> = [
  { id: "inbox", label: "À traiter" },
  { id: "library", label: "Bibliothèque" },
  { id: "connections", label: "Connexions" },
];

function proposalScope(proposal: HarnessProposal) {
  return proposal.scope.kind === "global" ? "Global" : `Projet ${proposal.scope.projectId}`;
}

function scopeLabel(resource: HubResource) {
  return resource.scope === "global" ? "Global" : resource.scope === "ancestor" ? "Ancêtre" : "Projet";
}

function isTrackedMcpProvider(value: string | undefined): value is "claude" | "opencode" {
  return value === "claude" || value === "opencode";
}

function driftLabel(drift: string) {
  switch (drift) {
    case "synchronized":
      return "Synchronisé";
    case "drifted":
      return "Dérive détectée";
    case "missing":
      return "Configuration absente";
    default:
      return "État inconnu";
  }
}

export function HarnessHubPage() {
  const environmentId = usePrimaryEnvironmentId();
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const projects = useProjects();
  const [view, setView] = useState<HubView>("inbox");
  const [selectedProject, setSelectedProject] = useState("");
  const [selectedEnvironment, setSelectedEnvironment] = useState<EnvironmentId | null>(null);
  const [scope, setScope] = useState<ScopeMode>("effective");
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [editingProposal, setEditingProposal] = useState(false);
  const [editRationale, setEditRationale] = useState("");
  const [editContent, setEditContent] = useState("");
  const [scopePreview, setScopePreview] = useState<HarnessHubScopePreviewResult | null>(null);
  const [mcpPreview, setMcpPreview] = useState<HarnessMcpDistributionPreviewResult | null>(null);
  const [mcpTargetProvider, setMcpTargetProvider] = useState<"codex" | "claude" | "opencode">(
    "codex",
  );
  const [mcpTargetScope, setMcpTargetScope] = useState<"project" | "global">("global");
  const [mcpApplyResult, setMcpApplyResult] = useState<string | null>(null);
  const [replaceManagedConflict, setReplaceManagedConflict] = useState(false);
  const [confirmRollbackId, setConfirmRollbackId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [providerFilter, setProviderFilter] = useState("all");
  const [ownershipFilter, setOwnershipFilter] = useState("all");
  const activeEnvironmentId =
    selectedEnvironment !== null &&
    environments.some((item) => item.environmentId === selectedEnvironment)
      ? selectedEnvironment
      : (environmentId ?? environments[0]?.environmentId ?? null);
  const projectOptions =
    activeEnvironmentId === null
      ? []
      : projects.filter((item) => item.environmentId === activeEnvironmentId);
  const canOperate = useEnvironmentScope(activeEnvironmentId, AuthOrchestrationOperateScope);
  const projectId = projectOptions.some((project) => project.id === selectedProject)
    ? selectedProject
    : (projectOptions[0]?.id ?? "");
  const proposalQuery = useEnvironmentQuery(
    activeEnvironmentId === null
      ? null
      : serverEnvironment.harnessProposals({ environmentId: activeEnvironmentId, input: {} }),
  );
  const resourcesQuery = useEnvironmentQuery(
    activeEnvironmentId === null
      ? null
      : serverEnvironment.harnessHubResources({
          environmentId: activeEnvironmentId,
          input: projectId ? { projectId } : {},
        }),
  );
  const scopeHistoryQuery = useEnvironmentQuery(
    activeEnvironmentId === null || !projectId
      ? null
      : serverEnvironment.harnessScopeHistory({
          environmentId: activeEnvironmentId,
          input: { scope: scope === "global" ? "global" : "project", projectId },
        }),
  );
  const mcpDeploymentsQuery = useEnvironmentQuery(
    activeEnvironmentId === null
      ? null
      : serverEnvironment.harnessMcpDeployments({ environmentId: activeEnvironmentId, input: {} }),
  );
  const approve = useAtomCommand(serverEnvironment.approveHarnessProposal, { reportFailure: true });
  const revise = useAtomCommand(serverEnvironment.reviseHarnessProposal, { reportFailure: true });
  const reject = useAtomCommand(serverEnvironment.rejectHarnessProposal, { reportFailure: true });
  const apply = useAtomCommand(serverEnvironment.applyHarnessProposal, { reportFailure: true });
  const rollback = useAtomCommand(serverEnvironment.rollbackHarnessProposal, {
    reportFailure: true,
  });
  const previewHarnessScope = useAtomCommand(serverEnvironment.previewHarnessScope, {
    reportFailure: true,
  });
  const applyHarnessScope = useAtomCommand(serverEnvironment.applyHarnessScope, {
    reportFailure: true,
  });
  const rollbackHarnessScope = useAtomCommand(serverEnvironment.rollbackHarnessScope, {
    reportFailure: true,
  });
  const previewHarnessMcpDistribution = useAtomCommand(
    serverEnvironment.previewHarnessMcpDistribution,
    { reportFailure: true },
  );
  const applyHarnessMcpDistribution = useAtomCommand(
    serverEnvironment.applyHarnessMcpDistribution,
    { reportFailure: true },
  );
  const adoptHarnessMcp = useAtomCommand(serverEnvironment.adoptHarnessMcp, {
    reportFailure: true,
  });
  const untrackHarnessMcp = useAtomCommand(serverEnvironment.untrackHarnessMcp, {
    reportFailure: true,
  });
  const proposals = proposalQuery.data?.proposals ?? [];
  const contextProposals = proposals.filter((item) => {
    if (scope === "global") return item.scope.kind === "global";
    if (scope === "project")
      return item.scope.kind === "project" && item.scope.projectId === projectId;
    return !projectId || item.scope.kind === "global" || item.scope.projectId === projectId;
  });
  const actionable = contextProposals.filter(
    (item) => item.status === "pending" || item.status === "approved",
  );
  const appliedProposals = contextProposals.filter((item) => item.status === "applied");
  const selectedProposal = contextProposals.find((item) => item.id === selectedProposalId) ?? null;
  const allResources = resourcesQuery.data?.resources ?? [];
  const scopeResources = allResources.filter(
    (item) =>
      scope === "effective" ||
      (scope === "global" ? item.scope === "global" : item.scope === "project"),
  );
  const mcpDeployments = (mcpDeploymentsQuery.data?.deployments ?? []).filter(
    (deployment) =>
      (scope === "effective" || deployment.targetScope === scope) &&
      (deployment.targetScope !== "project" || deployment.targetProjectId === projectId),
  );
  const providerOptions = [
    ...new Set(scopeResources.flatMap((item) => (item.provider ? [item.provider] : []))),
  ].sort();
  const filteredResources = scopeResources.filter(
    (item) =>
      `${item.name} ${item.description ?? ""} ${item.source}`
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (typeFilter === "all" || item.type === typeFilter) &&
      (providerFilter === "all" || item.provider === providerFilter) &&
      (ownershipFilter === "all" || item.ownership === ownershipFilter),
  );
  const selectedSkill = scopeResources.find((item) => item.id === selectedSkillId) ?? null;
  const refresh = () => {
    proposalQuery.refresh();
    resourcesQuery.refresh();
    scopeHistoryQuery.refresh();
    mcpDeploymentsQuery.refresh();
  };
  const runProposalAction = async (action: typeof approve, id: string) => {
    if (!activeEnvironmentId || !canOperate) return;
    const result = await action({ environmentId: activeEnvironmentId, input: { id } });
    if (result._tag === "Success") refresh();
  };
  const saveProposalRevision = async () => {
    if (!activeEnvironmentId || !canOperate || !selectedProposal) return;
    const result = await revise({
      environmentId: activeEnvironmentId,
      input: {
        id: selectedProposal.id,
        expectedUpdatedAt: selectedProposal.updatedAt,
        patch: {
          rationale: editRationale,
          contentDiff: { before: selectedProposal.contentDiff.before, after: editContent },
        },
      },
    });
    if (result._tag === "Success") {
      setEditingProposal(false);
      refresh();
    }
  };
  const showScopePreview = async (resource: HubResource) => {
    if (!activeEnvironmentId || !projectId || resource.type !== "skill" || !canOperate || resource.scope === "ancestor") return;
    const result = await previewHarnessScope({
      environmentId: activeEnvironmentId,
      input: {
        projectId,
        resourceId: resource.id,
        destinationScope: resource.scope === "global" ? "project" : "global",
      },
    });
    if (result._tag === "Success") {
      setScopePreview(result.value);
      setReplaceManagedConflict(false);
    }
  };
  const confirmScopeApply = async () => {
    if (!activeEnvironmentId || !scopePreview || !canOperate) return;
    const mayReplaceManaged =
      scopePreview.conflicts.length > 0 &&
      scopePreview.conflicts.every((item) => item.ownership === "managed");
    const result = await applyHarnessScope({
      environmentId: activeEnvironmentId,
      input: {
        previewId: scopePreview.previewId,
        confirmationToken: scopePreview.confirmationToken,
        confirmed: true,
        ...(mayReplaceManaged && replaceManagedConflict
          ? { resolution: "replace-managed" as const }
          : {}),
      },
    });
    if (result._tag === "Success") {
      setScopePreview(null);
      refresh();
    }
  };
  const previewMcpDistribution = async (resource: HubResource) => {
    if (!activeEnvironmentId || !canOperate || resource.type !== "mcp" || resource.scope === "ancestor") return;
    const result = await previewHarnessMcpDistribution({
      environmentId: activeEnvironmentId,
      input: {
        sourceResourceId: resource.id,
        sourceScope: resource.scope,
        ...(resource.projectId ? { sourceProjectId: resource.projectId } : {}),
        targetProvider: mcpTargetProvider,
        targetScope: mcpTargetScope,
        ...(mcpTargetScope === "project" && projectId ? { targetProjectId: projectId } : {}),
      },
    });
    if (result._tag === "Success") {
      setMcpPreview(result.value);
      setMcpApplyResult(null);
    }
  };
  const confirmMcpDistribution = async () => {
    if (
      !activeEnvironmentId ||
      !mcpPreview?.previewId ||
      !mcpPreview.confirmationToken ||
      !canOperate
    )
      return;
    const result = await applyHarnessMcpDistribution({
      environmentId: activeEnvironmentId,
      input: {
        previewId: mcpPreview.previewId,
        confirmationToken: mcpPreview.confirmationToken,
        confirmed: true,
      },
    });
    if (result._tag === "Success") {
      setMcpApplyResult(
        `${result.value.status}${result.value.reason ? ` · ${result.value.reason}` : ""}. Consultez Connexions pour le suivi disponible; l’authentification et la disponibilité restent inconnues.`,
      );
      setMcpPreview(null);
      refresh();
    }
  };
  const adoptMcpConfiguration = async (resource: HubResource) => {
    if (!activeEnvironmentId || !canOperate || resource.scope === "ancestor" || !isTrackedMcpProvider(resource.provider)) return;
    const result = await adoptHarnessMcp({
      environmentId: activeEnvironmentId,
      input: {
        sourceResourceId: resource.id,
        sourceScope: resource.scope,
        ...(resource.projectId ? { sourceProjectId: resource.projectId } : {}),
        targetProvider: resource.provider,
        targetScope: resource.scope,
        ...(resource.scope === "project" && resource.projectId
          ? { targetProjectId: resource.projectId }
          : {}),
      },
    });
    if (result._tag === "Success") refresh();
  };
  const stopTrackingMcp = async (deploymentId: string) => {
    if (!activeEnvironmentId || !canOperate) return;
    const result = await untrackHarnessMcp({
      environmentId: activeEnvironmentId,
      input: { id: deploymentId },
    });
    if (result._tag === "Success") refresh();
  };
  const rollbackScopeHistory = async (entryId: string) => {
    if (!activeEnvironmentId || !projectId || !canOperate) return;
    const result = await rollbackHarnessScope({
      environmentId: activeEnvironmentId,
      input: { scope: scope === "global" ? "global" : "project", projectId, entryId },
    });
    if (result._tag === "Success") {
      setConfirmRollbackId(null);
      refresh();
    }
  };

  return (
    <WorkspacePageContainer
      width="expanded"
      className="scrollbar-gutter-both min-h-0 flex-1 gap-5 overflow-auto py-6"
    >
      <main className="flex min-h-0 w-full flex-1 flex-col gap-5">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">Harness Hub</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Ressources et connexions de l’environnement
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void navigate({ to: "/settings", hash: "harness-settings" })}
          >
            <Settings2Icon className="mr-2 size-4" />
            Paramètres
          </Button>
        </header>
        <div className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
          <label className="sr-only" htmlFor="harness-environment">
            Environnement
          </label>
          <select
            id="harness-environment"
            className="h-9 max-w-52 rounded-md border border-input bg-background px-3 text-sm"
            value={activeEnvironmentId ?? ""}
            onChange={(event) => {
              setSelectedEnvironment((event.target.value || null) as EnvironmentId | null);
              setSelectedProject("");
            }}
            aria-label="Environnement"
          >
            <option value="">Aucun environnement</option>
            {environments.map((item) => (
              <option key={item.environmentId} value={item.environmentId}>
                {item.label}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor="harness-project">
            Projet
          </label>
          <select
            id="harness-project"
            className="h-9 max-w-56 rounded-md border border-input bg-background px-3 text-sm"
            value={projectId}
            onChange={(event) => setSelectedProject(event.target.value)}
          >
            <option value="">Choisir un projet</option>
            {projectOptions.map((project) => (
              <option key={project.id} value={project.id}>
                {project.title}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor="harness-scope">
            Portée
          </label>
          <select
            id="harness-scope"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={scope}
            onChange={(event) => setScope(event.target.value as ScopeMode)}
          >
            <option value="effective">Effective</option>
            <option value="project">Projet</option>
            <option value="global">Global</option>
          </select>
          <nav aria-label="Vues Harness" className="ml-auto flex gap-1">
            {VIEWS.map((item) => (
              <Button
                key={item.id}
                size="sm"
                variant={view === item.id ? "secondary" : "ghost"}
                onClick={() => setView(item.id)}
              >
                {item.label}
                {item.id === "inbox" && actionable.length > 0 ? (
                  <span className="ml-2 text-xs text-muted-foreground">{actionable.length}</span>
                ) : null}
              </Button>
            ))}
          </nav>
        </div>

        {(proposalQuery.error || resourcesQuery.error || mcpDeploymentsQuery.error) && (
          <p role="alert" className="text-sm text-destructive">
            {proposalQuery.error || resourcesQuery.error || mcpDeploymentsQuery.error}
          </p>
        )}
        {view === "inbox" ? (
          <section className="grid min-h-0 flex-1 gap-4 md:grid-cols-[minmax(0,1fr)_minmax(18rem,0.8fr)]">
            <div className="min-w-0">
              <h2 className="mb-3 text-sm font-medium">
                À traiter <span className="text-muted-foreground">{actionable.length}</span>
              </h2>
              {proposalQuery.isPending ? (
                <p className="py-8 text-sm text-muted-foreground">Chargement des propositions…</p>
              ) : actionable.length === 0 && appliedProposals.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border p-8 text-center">
                  <CircleAlertIcon className="mx-auto mb-2 size-5 text-muted-foreground" />
                  <p className="text-sm font-medium">Rien à traiter</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Les propositions Harness apparaîtront ici lorsqu’une décision sera nécessaire.
                  </p>
                </div>
              ) : (
                <>
                  {actionable.length > 0 ? (
                    <div className="divide-y divide-border rounded-lg border border-border">
                      {actionable.map((item) => (
                        <button
                          key={item.id}
                          className="block w-full px-4 py-3 text-left hover:bg-muted/40"
                          onClick={() => setSelectedProposalId(item.id)}
                        >
                          <span className="flex items-center justify-between gap-3">
                            <span className="truncate text-sm font-medium">
                              {item.skillName} · {item.operation}
                            </span>
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {item.status === "pending" ? "À approuver" : "Approuvée"}
                            </span>
                          </span>
                          <span className="mt-1 block truncate text-xs text-muted-foreground">
                            {proposalScope(item)} · {item.rationale}
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {appliedProposals.length > 0 ? (
                    <div className="mt-5">
                      <h3 className="mb-2 text-xs font-medium text-muted-foreground">
                        Modifications récentes · annulation disponible
                      </h3>
                      <div className="divide-y divide-border rounded-lg border border-border">
                        {appliedProposals.map((item) => (
                          <button
                            key={item.id}
                            className="block w-full px-4 py-3 text-left hover:bg-muted/40"
                            onClick={() => setSelectedProposalId(item.id)}
                          >
                            <span className="block truncate text-sm font-medium">
                              {item.skillName} · {item.operation}
                            </span>
                            <span className="mt-1 block truncate text-xs text-muted-foreground">
                              {proposalScope(item)} · Appliquée
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </>
              )}
            </div>
            <aside className="min-w-0 rounded-lg border border-border p-4">
              {selectedProposal ? (
                <>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Proposition · {proposalScope(selectedProposal)}
                  </p>
                  <h3 className="mt-2 text-base font-semibold">
                    {selectedProposal.skillName} · {selectedProposal.operation}
                  </h3>
                  {editingProposal ? (
                    <div className="mt-3 space-y-3">
                      <label className="block text-xs font-medium">
                        Justification
                        <Textarea
                          className="mt-1"
                          value={editRationale}
                          onChange={(event) => setEditRationale(event.target.value)}
                        />
                      </label>
                      <label className="block text-xs font-medium">
                        Contenu proposé
                        <Textarea
                          className="mt-1 min-h-32"
                          size="sm"
                          value={editContent}
                          onChange={(event) => setEditContent(event.target.value)}
                        />
                      </label>
                    </div>
                  ) : (
                    <>
                      <p className="mt-2 text-sm text-muted-foreground">
                        {selectedProposal.rationale}
                      </p>
                      <p className="mt-3 text-xs text-muted-foreground">
                        Confiance {Math.round(selectedProposal.confidence * 100)}% ·{" "}
                        {selectedProposal.engineId} ·{" "}
                        {new Date(selectedProposal.createdAt).toLocaleDateString()}
                      </p>
                      <details className="mt-4 rounded-md border border-border">
                        <summary className="cursor-pointer px-3 py-2 text-xs font-medium">
                          Comparer avant / après
                        </summary>
                        <div className="grid gap-2 border-t border-border p-3 sm:grid-cols-2">
                          <div>
                            <p className="mb-1 text-xs font-medium">Avant</p>
                            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
                              {selectedProposal.contentDiff.before ?? "(aucun contenu)"}
                            </pre>
                          </div>
                          <div>
                            <p className="mb-1 text-xs font-medium">Après</p>
                            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
                              {selectedProposal.contentDiff.after ?? "(aucun contenu)"}
                            </pre>
                          </div>
                        </div>
                      </details>
                    </>
                  )}
                  <div className="mt-4 flex flex-wrap gap-2">
                    {editingProposal ? (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setEditingProposal(false)}
                        >
                          Annuler
                        </Button>
                        <Button
                          size="sm"
                          disabled={!canOperate}
                          onClick={() => void saveProposalRevision()}
                        >
                          Enregistrer la révision
                        </Button>
                      </>
                    ) : selectedProposal.status === "pending" ? (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!canOperate}
                          onClick={() => void runProposalAction(reject, selectedProposal.id)}
                        >
                          Refuser
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!canOperate}
                          onClick={() => {
                            setEditRationale(selectedProposal.rationale);
                            setEditContent(selectedProposal.contentDiff.after ?? "");
                            setEditingProposal(true);
                          }}
                        >
                          Modifier
                        </Button>
                        <Button
                          size="sm"
                          disabled={!canOperate}
                          onClick={() => void runProposalAction(approve, selectedProposal.id)}
                        >
                          Approuver
                        </Button>
                      </>
                    ) : selectedProposal.status === "approved" ? (
                      <Button
                        size="sm"
                        disabled={!canOperate}
                        onClick={() => void runProposalAction(apply, selectedProposal.id)}
                      >
                        Appliquer
                      </Button>
                    ) : selectedProposal.status === "applied" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!canOperate}
                        onClick={() => void runProposalAction(rollback, selectedProposal.id)}
                      >
                        Annuler l’application
                      </Button>
                    ) : null}
                  </div>
                </>
              ) : (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  Sélectionnez une proposition pour consulter ses détails.
                </p>
              )}
            </aside>
          </section>
        ) : null}

        {view === "library" ? (
          <section className="grid min-h-0 flex-1 gap-4 md:grid-cols-[minmax(0,1fr)_minmax(18rem,0.8fr)]">
            <div className="min-w-0">
              {scope === "effective" ? (
                <p className="mb-3 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                  Résolution effective inconnue : les ressources globales et du projet sont
                  affichées ensemble; la priorité des substitutions dépend du fournisseur.
                </p>
              ) : null}
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <h2 className="mr-auto text-sm font-medium">Bibliothèque</h2>
                <InputGroup className="w-48">
                  <InputGroupAddon>
                    <SearchIcon className="size-4 text-muted-foreground" />
                  </InputGroupAddon>
                  <InputGroupInput
                    aria-label="Rechercher les ressources"
                    placeholder="Rechercher…"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </InputGroup>
                <select
                  aria-label="Type de ressource"
                  className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                  value={typeFilter}
                  onChange={(event) => setTypeFilter(event.target.value)}
                >
                  <option value="all">Tous les types</option>
                  {["skill", "rule", "agent", "hook", "mcp", "unknown"].map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Fournisseur"
                  className="h-9 max-w-40 rounded-md border border-input bg-background px-2 text-sm"
                  value={providerFilter}
                  onChange={(event) => setProviderFilter(event.target.value)}
                >
                  <option value="all">Tous les fournisseurs</option>
                  {providerOptions.map((provider) => (
                    <option key={provider} value={provider}>
                      {provider}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Propriété"
                  className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                  value={ownershipFilter}
                  onChange={(event) => setOwnershipFilter(event.target.value)}
                >
                  <option value="all">Toutes les origines</option>
                  <option value="managed">Harness</option>
                  <option value="user">Externe</option>
                  <option value="unknown">Inconnue</option>
                </select>
              </div>
              {resourcesQuery.isPending ? (
                <p className="py-8 text-sm text-muted-foreground">Chargement de l’inventaire…</p>
              ) : filteredResources.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border p-8 text-center">
                  <BookOpenIcon className="mx-auto mb-2 size-5 text-muted-foreground" />
                  <p className="text-sm font-medium">Aucune ressource trouvée</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Les ressources découvertes pour cette portée apparaîtront ici.
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-border rounded-lg border border-border">
                  {filteredResources.map((resource) => (
                    <button
                      key={resource.id}
                      className="block w-full px-4 py-3 text-left hover:bg-muted/40"
                      onClick={() => {
                        setSelectedSkillId(resource.id);
                        setScopePreview(null);
                        setMcpPreview(null);
                        setMcpApplyResult(null);
                      }}
                    >
                      <span className="flex items-center justify-between gap-3">
                        <span className="truncate text-sm font-medium">{resource.name}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {resource.type} · {scopeLabel(resource)}
                        </span>
                      </span>
                      <span className="mt-1 block truncate text-xs text-muted-foreground">
                        {resource.description ?? resource.source} ·{" "}
                        {resource.ownership === "managed"
                          ? "Harness"
                          : resource.ownership === "user"
                            ? "Externe"
                            : "Propriété inconnue"}
                        {resource.provider ? ` · ${resource.provider}` : ""}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <aside className="rounded-lg border border-border p-4">
              {selectedSkill ? (
                <>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    {selectedSkill.type} · {scopeLabel(selectedSkill)}
                  </p>
                  <h3 className="mt-2 text-base font-semibold">{selectedSkill.name}</h3>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {selectedSkill.description ?? "Aucune description fournie."}
                  </p>
                  <dl className="mt-4 space-y-2 text-xs text-muted-foreground">
                    <div>
                      <dt className="inline font-medium text-foreground">Origine : </dt>
                      <dd className="inline break-all">{selectedSkill.source}</dd>
                    </div>
                    <div>
                      <dt className="inline font-medium text-foreground">Propriété : </dt>
                      <dd className="inline">{selectedSkill.ownership}</dd>
                    </div>
                    {selectedSkill.provider ? (
                      <div>
                        <dt className="inline font-medium text-foreground">Fournisseur : </dt>
                        <dd className="inline">{selectedSkill.provider}</dd>
                      </div>
                    ) : null}
                    <div>
                      <dt className="inline font-medium text-foreground">État : </dt>
                      <dd className="inline">
                        {selectedSkill.status === "installed"
                          ? "Présent dans la configuration native; connexion non vérifiée"
                          : "État inconnu"}
                      </dd>
                    </div>
                  </dl>
                  <p className="mt-4 text-xs text-muted-foreground">
                    {selectedSkill.operations.length
                      ? `Opérations prises en charge : ${selectedSkill.operations.join(", ")}`
                      : "Aucune opération de gestion prise en charge."}
                  </p>
                  {selectedSkill.type === "skill" && projectId ? (
                    <Button
                      className="mt-4"
                      size="sm"
                      variant="outline"
                      disabled={!canOperate}
                      onClick={() => void showScopePreview(selectedSkill)}
                    >
                      {selectedSkill.scope === "global"
                        ? "Créer une copie projet"
                        : "Promouvoir en global"}
                    </Button>
                  ) : null}
                  {selectedSkill.type === "mcp" ? (
                    <div className="mt-5 space-y-3 border-t border-border pt-4">
                      <h4 className="text-sm font-medium">Distribuer cette configuration</h4>
                      <div className="flex flex-wrap gap-2">
                        <label className="grid gap-1 text-xs text-muted-foreground">
                          Fournisseur cible
                          <select
                            className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
                            value={mcpTargetProvider}
                            onChange={(event) => {
                              setMcpTargetProvider(event.target.value as typeof mcpTargetProvider);
                              setMcpPreview(null);
                            }}
                          >
                            <option value="codex">Codex</option>
                            <option value="claude">Claude Code</option>
                            <option value="opencode">OpenCode</option>
                          </select>
                        </label>
                        <label className="grid gap-1 text-xs text-muted-foreground">
                          Portée cible
                          <select
                            className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
                            value={mcpTargetScope}
                            onChange={(event) => {
                              setMcpTargetScope(event.target.value as typeof mcpTargetScope);
                              setMcpPreview(null);
                            }}
                          >
                            <option value="global">Global</option>
                            <option value="project">Projet</option>
                          </select>
                        </label>
                      </div>
                      {mcpTargetScope === "project" && !projectId ? (
                        <p className="text-xs text-muted-foreground">
                          Choisissez un projet pour une distribution locale.
                        </p>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!canOperate}
                          onClick={() => void previewMcpDistribution(selectedSkill)}
                        >
                          Prévisualiser
                        </Button>
                      )}
                      {mcpPreview ? (
                        <div className="space-y-2 rounded-md border border-border p-3">
                          <p className="text-sm font-medium">
                            État de l’aperçu : {mcpPreview.status}
                          </p>
                          {mcpPreview.sourceName ? (
                            <p className="text-xs text-muted-foreground">
                              {mcpPreview.sourceName} ·{" "}
                              {mcpPreview.sourceProvider ?? "source fournisseur inconnue"} →{" "}
                              {mcpPreview.targetProvider} · {mcpPreview.targetScope}
                            </p>
                          ) : null}
                          {mcpPreview.reason ? (
                            <p className="text-sm text-muted-foreground">{mcpPreview.reason}</p>
                          ) : null}
                          {mcpPreview.before !== null || mcpPreview.after !== null ? (
                            <div className="grid gap-2 sm:grid-cols-2">
                              <div>
                                <p className="mb-1 text-xs font-medium">Avant</p>
                                <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
                                  {mcpPreview.before ?? "Aucune configuration cible"}
                                </pre>
                              </div>
                              <div>
                                <p className="mb-1 text-xs font-medium">Après</p>
                                <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
                                  {mcpPreview.after ?? "Aucun changement"}
                                </pre>
                              </div>
                            </div>
                          ) : null}
                          <p className="text-xs text-muted-foreground">
                            Authentification et disponibilité : inconnues.
                          </p>
                          {mcpPreview.status === "ready" &&
                          mcpPreview.previewId &&
                          mcpPreview.confirmationToken ? (
                            <Button
                              size="sm"
                              disabled={!canOperate}
                              onClick={() => void confirmMcpDistribution()}
                            >
                              Confirmer et distribuer
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                      {mcpApplyResult ? (
                        <p className="rounded-md bg-muted p-2 text-xs text-muted-foreground">
                          {mcpApplyResult}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                  {scopePreview ? (
                    <div className="mt-4 space-y-3 rounded-md border border-border p-3">
                      <p className="text-sm font-medium">
                        Aperçu : {scopePreview.sourceName} → {scopePreview.destinationName} (
                        {scopePreview.destinationScope})
                      </p>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <div>
                          <p className="mb-1 text-xs font-medium">Avant</p>
                          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
                            {scopePreview.before ?? "Aucune ressource à remplacer"}
                          </pre>
                        </div>
                        <div>
                          <p className="mb-1 text-xs font-medium">Après</p>
                          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
                            {scopePreview.after}
                          </pre>
                        </div>
                      </div>
                      {scopePreview.conflicts.length ? (
                        <div className="rounded-md border border-destructive/40 p-2 text-xs">
                          <p className="font-medium">Conflit de destination</p>
                          <p className="mt-1">
                            {scopePreview.conflicts
                              .map((item) => `${item.name} (${item.ownership})`)
                              .join(", ")}
                          </p>
                          {scopePreview.conflicts.every((item) => item.ownership === "managed") ? (
                            <label className="mt-2 flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={replaceManagedConflict}
                                onChange={(event) =>
                                  setReplaceManagedConflict(event.target.checked)
                                }
                              />
                              Remplacer explicitement la ressource gérée
                            </label>
                          ) : (
                            <p className="mt-1">
                              La ressource externe ne peut pas être remplacée depuis cet aperçu.
                            </p>
                          )}
                        </div>
                      ) : null}
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" onClick={() => setScopePreview(null)}>
                          Annuler
                        </Button>
                        <Button
                          size="sm"
                          disabled={
                            !canOperate ||
                            (scopePreview.conflicts.length > 0 &&
                              (!scopePreview.conflicts.every(
                                (item) => item.ownership === "managed",
                              ) ||
                                !replaceManagedConflict))
                          }
                          onClick={() => void confirmScopeApply()}
                        >
                          Confirmer et appliquer
                        </Button>
                      </div>
                    </div>
                  ) : null}
                  {scopeHistoryQuery.data?.entries.length ? (
                    <div className="mt-5 border-t border-border pt-4">
                      <h4 className="mb-2 text-xs font-medium">Historique et annulation</h4>
                      <div className="space-y-2">
                        {scopeHistoryQuery.data.entries.map((entry) => (
                          <div
                            key={entry.id}
                            className="flex flex-wrap items-center justify-between gap-2 text-xs"
                          >
                            <span>
                              {entry.sourceName} → {entry.destinationName} ·{" "}
                              {new Date(entry.createdAt).toLocaleDateString()}
                            </span>
                            {confirmRollbackId === entry.id ? (
                              <span className="flex gap-1">
                                <Button
                                  size="xs"
                                  variant="outline"
                                  onClick={() => setConfirmRollbackId(null)}
                                >
                                  Retour
                                </Button>
                                <Button
                                  size="xs"
                                  variant="outline"
                                  disabled={!canOperate}
                                  onClick={() => void rollbackScopeHistory(entry.id)}
                                >
                                  Confirmer
                                </Button>
                              </span>
                            ) : (
                              <Button
                                size="xs"
                                variant="outline"
                                disabled={!canOperate}
                                onClick={() => setConfirmRollbackId(entry.id)}
                              >
                                Annuler
                              </Button>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  Sélectionnez une ressource pour la consulter.
                </p>
              )}
            </aside>
          </section>
        ) : null}

        {view === "connections" ? (
          <section className="max-w-3xl">
            <div className="mb-3 flex items-center gap-2">
              <Link2Icon className="size-4 text-muted-foreground" />
              <h2 className="text-sm font-medium">Connexions des fournisseurs</h2>
            </div>
            <div className="mb-4 rounded-lg border border-border bg-muted/30 p-4 text-sm">
              <p className="font-medium">Authentification manuelle auprès du fournisseur</p>
              <p className="mt-1 text-muted-foreground">
                Pour les serveurs qui demandent une connexion, suivez la documentation et le flux
                d’authentification natifs de Codex, Claude Code ou OpenCode. T3 ne lance pas le
                parcours OAuth et ne vérifie pas l’accès ni la disponibilité du serveur.
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                Les états OAuth et la disponibilité d’exécution restent inconnus. La dérive compare
                les empreintes de configuration sans secrets et ne vérifie pas l’accès au serveur.
              </p>
            </div>
            {scopeResources.filter((item) => item.type === "mcp").length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-8">
                <p className="text-sm font-medium">Aucune configuration MCP découverte</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Les états d’authentification et la disponibilité d’exécution ne sont pas rapportés
                  par l’inventaire.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-border rounded-lg border border-border">
                {scopeResources
                  .filter((item) => item.type === "mcp")
                  .map((item) => (
                    <div
                      key={item.id}
                      className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                    >
                      <div>
                        <p className="text-sm font-medium">{item.name}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {item.provider ?? "Fournisseur inconnu"} ·{" "}
                          {item.status === "installed"
                            ? "Configuré; authentification non vérifiée"
                            : "État inconnu"}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {isTrackedMcpProvider(item.provider)
                            ? mcpDeployments.some(
                                (deployment) =>
                                  deployment.sourceResourceId === item.id &&
                                  deployment.targetProvider === item.provider &&
                                  deployment.targetScope === item.scope,
                              )
                              ? "Suivi Harness actif"
                              : "Configuration découverte, non suivie"
                            : "Suivi Harness non pris en charge pour ce fournisseur"}
                        </p>
                      </div>
                      {isTrackedMcpProvider(item.provider) &&
                      !mcpDeployments.some(
                        (deployment) =>
                          deployment.sourceResourceId === item.id &&
                          deployment.targetProvider === item.provider &&
                          deployment.targetScope === item.scope,
                      ) ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!canOperate}
                          onClick={() => void adoptMcpConfiguration(item)}
                        >
                          Adopter le suivi
                        </Button>
                      ) : null}
                    </div>
                  ))}
              </div>
            )}
            {mcpDeploymentsQuery.isPending ? (
              <p className="mt-4 text-sm text-muted-foreground">
                Chargement des déploiements suivis…
              </p>
            ) : mcpDeployments.length > 0 ? (
              <div className="mt-5">
                <h3 className="mb-2 text-sm font-medium">Déploiements suivis</h3>
                <div className="divide-y divide-border rounded-lg border border-border">
                  {mcpDeployments.map((deployment) => (
                    <div
                      key={deployment.id}
                      className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                    >
                      <div>
                        <p className="text-sm font-medium">{deployment.serverName}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {deployment.targetProvider} · {deployment.targetScope}
                          {deployment.targetScope === "project"
                            ? ` · ${deployment.targetProjectId}`
                            : ""}
                          {` · ${driftLabel(deployment.drift)}`}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Suivi {deployment.trackingOrigin === "adopted" ? "adopté" : "appliqué"} ·{" "}
                          authentification non vérifiée
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!canOperate}
                        onClick={() => void stopTrackingMcp(deployment.id)}
                      >
                        Arrêter le suivi
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </section>
        ) : null}
      </main>
    </WorkspacePageContainer>
  );
}
