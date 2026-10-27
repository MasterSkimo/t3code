import {
  ProviderInstanceId,
  type HarnessAuditEntry,
  type HarnessDefaults,
  type HarnessProposal,
  type HarnessSkillUsageMetricsAvailability,
  type HarnessSkillSummary,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState, type FormEvent } from "react";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { searchableSetting } from "./settingsSearch";

const isProviderInstanceId = Schema.is(ProviderInstanceId);

export interface HarnessMetrics {
  readonly proposalCount: number;
  readonly approvedCount: number;
  readonly appliedCount: number;
  readonly rejectedCount: number;
  readonly lastLearnedAt?: string | null;
}

export interface HarnessSettingsPanelProps {
  readonly defaults: HarnessDefaults;
  readonly proposals: readonly HarnessProposal[];
  readonly audit: readonly HarnessAuditEntry[];
  readonly inventory: readonly HarnessSkillSummary[];
  readonly usageMetrics: HarnessSkillUsageMetricsAvailability;
  readonly metrics: HarnessMetrics;
  readonly busy?: boolean;
  readonly notice?: string | null;
  readonly onSave: (defaults: HarnessDefaults) => void | Promise<void>;
  readonly onLearn?: (context: string) => void | Promise<void>;
  readonly onApprove: (id: string) => void | Promise<void>;
  readonly onReject: (id: string) => void | Promise<void>;
  readonly onApply: (id: string) => void | Promise<void>;
  readonly onRollback: (id: string) => void | Promise<void>;
}

function dateLabel(value: string | null | undefined): string {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function ProposalCard({
  proposal,
  busy,
  onApprove,
  onReject,
  onApply,
  onRollback,
}: {
  proposal: HarnessProposal;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  onApply: () => void;
  onRollback: () => void;
}) {
  const scope = proposal.scope.kind === "global" ? "Global" : `Project ${proposal.scope.projectId}`;
  return (
    <article className="rounded-lg border border-border/70 bg-background/50 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">
              {proposal.skillName} · {proposal.operation}
            </h3>
            <span className="rounded-full border border-border px-2 py-0.5 text-2xs capitalize text-muted-foreground">
              {proposal.status}
            </span>
            <span className="text-2xs text-muted-foreground">{scope}</span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{proposal.rationale}</p>
          <p className="mt-1 text-2xs text-muted-foreground">
            {proposal.engineId} · {proposal.engineVersion} · {Math.round(proposal.confidence * 100)}
            % confidence · {dateLabel(proposal.createdAt)}
          </p>
        </div>
        {proposal.status === "pending" ? (
          <div className="flex gap-1.5">
            <Button size="xs" variant="outline" disabled={busy} onClick={onReject}>
              Reject
            </Button>
            <Button size="xs" disabled={busy} onClick={onApprove}>
              Approve
            </Button>
          </div>
        ) : proposal.status === "approved" ? (
          <Button size="xs" disabled={busy} onClick={onApply}>
            Apply
          </Button>
        ) : proposal.status === "applied" ? (
          <Button size="xs" variant="outline" disabled={busy} onClick={onRollback}>
            Rollback
          </Button>
        ) : null}
      </div>
      {proposal.targetSkillIds.length > 0 && (
        <p className="mt-2 text-2xs text-muted-foreground">
          Skills: {proposal.targetSkillIds.join(", ")}
        </p>
      )}
      {(proposal.evidence.length > 0 || proposal.sourceRefs.length > 0) && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            Evidence and sources ({proposal.evidence.length + proposal.sourceRefs.length})
          </summary>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-muted-foreground">
            {[...new Set(proposal.evidence)].map((item) => (
              <li key={`evidence-${item}`}>{item}</li>
            ))}
            {[...new Set(proposal.sourceRefs)].map((item) => (
              <li key={`source-${item}`}>
                <code>{item}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
      {(proposal.contentDiff.before !== null || proposal.contentDiff.after !== null) && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-muted-foreground">Review content change</summary>
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            <pre className="max-h-48 overflow-auto rounded-md bg-muted/50 p-2 text-2xs whitespace-pre-wrap">
              {proposal.contentDiff.before ?? "(new content)"}
            </pre>
            <pre className="max-h-48 overflow-auto rounded-md bg-muted/50 p-2 text-2xs whitespace-pre-wrap">
              {proposal.contentDiff.after ?? "(removed)"}
            </pre>
          </div>
        </details>
      )}
    </article>
  );
}

export function HarnessSettingsPanel({
  defaults,
  proposals,
  audit,
  inventory,
  usageMetrics,
  metrics,
  busy = false,
  notice,
  onSave,
  onLearn,
  onApprove,
  onReject,
  onApply,
  onRollback,
}: HarnessSettingsPanelProps) {
  const [enabled, setEnabled] = useState(defaults.enabled);
  const [autoLearn, setAutoLearn] = useState(defaults.autoLearn);
  const [minimumConfidence, setMinimumConfidence] = useState(String(defaults.minimumConfidence));
  const [engineDraft, setEngineDraft] = useState(defaults.engineId);
  const [modelInstanceDraft, setModelInstanceDraft] = useState(
    defaults.modelSelection?.instanceId ?? "",
  );
  const [modelDraft, setModelDraft] = useState(defaults.modelSelection?.model ?? "");
  const [dailyBudget, setDailyBudget] = useState(String(defaults.dailyAnalysisBudget));
  const [configError, setConfigError] = useState<string | null>(null);
  const [learningContext, setLearningContext] = useState("");

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const confidence = Number(minimumConfidence);
    const budget = Number(dailyBudget);
    if (
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1 ||
      !Number.isInteger(budget) ||
      budget < 0 ||
      budget > 1000
    )
      return;
    const instanceId = modelInstanceDraft.trim();
    const model = modelDraft.trim();
    if (Boolean(instanceId) !== Boolean(model)) {
      setConfigError("Enter both the provider instance and model ID, or leave both blank.");
      return;
    }
    if (instanceId && !isProviderInstanceId(instanceId)) {
      setConfigError("Provider instance ID has an invalid format.");
      return;
    }
    setConfigError(null);
    void onSave({
      ...defaults,
      enabled,
      autoLearn,
      engineId: engineDraft.trim(),
      modelSelection:
        instanceId && model ? { instanceId: ProviderInstanceId.make(instanceId), model } : null,
      dailyAnalysisBudget: budget,
      minimumConfidence: confidence,
    });
  };

  return (
    <>
      {notice && (
        <p
          role="status"
          className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning-foreground"
        >
          {notice}
        </p>
      )}
      <SettingsSection id="harness-settings" title="Harness learning">
        <form onSubmit={submit}>
          <SettingsRow
            {...searchableSetting("harness-learning")}
            title="Enable learning"
            description="Collect and learn reusable skills from completed work. Proposals remain reviewable before they change the inventory."
            control={
              <Switch
                checked={enabled}
                onCheckedChange={(checked) => setEnabled(Boolean(checked))}
                aria-label="Enable Harness learning"
              />
            }
          />
          <SettingsRow
            title="Learn automatically"
            description="Analyze eligible completed work in the background, subject to the daily budget."
            control={
              <Switch
                checked={autoLearn}
                onCheckedChange={(checked) => setAutoLearn(Boolean(checked))}
                aria-label="Enable automatic Harness learning"
              />
            }
          />
          <div className="grid gap-3 border-t border-border/50 px-4 py-3 md:grid-cols-2">
            <label className="grid gap-1 text-xs text-muted-foreground">
              Engine ID
              <Input
                value={engineDraft}
                onChange={(event) => setEngineDraft(event.target.value)}
                placeholder="native-v1"
              />
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              Model provider instance
              <Input
                value={modelInstanceDraft}
                onChange={(event) => setModelInstanceDraft(event.target.value)}
                placeholder="Optional instance ID"
              />
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              Model ID
              <Input
                value={modelDraft}
                onChange={(event) => setModelDraft(event.target.value)}
                placeholder="Optional model ID"
              />
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              Daily analysis budget
              <Input
                type="number"
                min="0"
                max="1000"
                step="1"
                value={dailyBudget}
                onChange={(event) => setDailyBudget(event.target.value)}
              />
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              Minimum confidence (0–1)
              <Input
                type="number"
                min="0"
                max="1"
                step="0.01"
                value={minimumConfidence}
                onChange={(event) => setMinimumConfidence(event.target.value)}
              />
            </label>
            <div className="flex items-end justify-end">
              <Button type="submit" size="sm" disabled={busy}>
                Save settings
              </Button>
            </div>
          </div>
          {configError && <p className="px-4 pb-3 text-xs text-destructive">{configError}</p>}
        </form>
        {onLearn && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/50 px-4 py-3">
            <div>
              <p className="text-sm font-medium">Manual learning run</p>
              <p className="text-xs text-muted-foreground">
                Analyze work and prepare proposals for review. Add context to guide the analysis.
              </p>
              <Textarea
                size="sm"
                rows={2}
                maxLength={12_000}
                value={learningContext}
                onChange={(event) => setLearningContext(event.target.value)}
                placeholder="Optional: describe a useful pattern or recent work to analyze"
                aria-label="Context for manual Harness learning"
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void onLearn(learningContext.trim())}
            >
              Learn now
            </Button>
          </div>
        )}
      </SettingsSection>

      <SettingsSection id="harness-metrics" title="Activity">
        <div className="grid grid-cols-2 gap-px bg-border/50 sm:grid-cols-4">
          {[
            ["Proposals", metrics.proposalCount],
            ["Approved", metrics.approvedCount],
            ["Applied", metrics.appliedCount],
            ["Rejected", metrics.rejectedCount],
          ].map(([label, value]) => (
            <div key={label} className="bg-background px-4 py-3">
              <p className="text-2xs uppercase tracking-wide text-muted-foreground">{label}</p>
              <p className="mt-1 font-mono text-lg tabular-nums">{value}</p>
            </div>
          ))}
        </div>
        <div className="px-4 py-2 text-xs text-muted-foreground">
          Last learned: {dateLabel(metrics.lastLearnedAt)}
        </div>
      </SettingsSection>

      <SettingsSection id="harness-proposals" title={`Proposals (${proposals.length})`}>
        <div className="grid gap-2 p-3">
          {proposals.length === 0 ? (
            <p className="px-1 py-3 text-sm text-muted-foreground">
              No proposals yet. Run learning to prepare a change for review.
            </p>
          ) : (
            proposals.map((proposal) => (
              <ProposalCard
                key={proposal.id}
                proposal={proposal}
                busy={busy}
                onApprove={() => void onApprove(proposal.id)}
                onReject={() => void onReject(proposal.id)}
                onApply={() => void onApply(proposal.id)}
                onRollback={() => void onRollback(proposal.id)}
              />
            ))
          )}
        </div>
      </SettingsSection>

      <SettingsSection id="harness-inventory" title={`Skill inventory (${inventory.length})`}>
        {usageMetrics.status === "unavailable" &&
        usageMetrics.reason === "skill-usage-not-attributed" ? (
          <p className="px-4 py-2 text-xs text-muted-foreground">
            Skill usage metrics unavailable: T3 Code does not attribute agent activity to individual
            skills.
          </p>
        ) : null}
        <div className="divide-y divide-border/50">
          {inventory.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">
              No learned skills are available.
            </p>
          ) : (
            inventory.map((item) => (
              <div
                key={item.id}
                className="flex flex-wrap items-start justify-between gap-2 px-4 py-3"
              >
                <div>
                  <p className="text-sm font-medium">{item.name}</p>
                  {item.description && (
                    <p className="mt-0.5 text-xs text-muted-foreground">{item.description}</p>
                  )}
                  <div className="flex gap-2 text-2xs text-muted-foreground">
                    <span className="capitalize">{item.scope}</span>
                    <span>{item.managed ? "Harness managed" : "User managed"}</span>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </SettingsSection>

      <SettingsSection id="harness-history" title={`History (${audit.length})`}>
        <div className="divide-y divide-border/50">
          {audit.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">No activity recorded.</p>
          ) : (
            audit.map((entry) => (
              <div
                key={entry.id}
                className="flex flex-wrap justify-between gap-2 px-4 py-2.5 text-xs"
              >
                <span className="capitalize">
                  {entry.action} <code className="text-muted-foreground">{entry.proposalId}</code>
                  {entry.note ? `: ${entry.note}` : ""}
                </span>
                <span className="shrink-0 text-muted-foreground">{dateLabel(entry.at)}</span>
              </div>
            ))
          )}
        </div>
      </SettingsSection>
    </>
  );
}
