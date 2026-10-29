import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Harness from "./HarnessProposalService.ts";
import * as HarnessSkills from "./HarnessSkillsService.ts";

const skillReceipt = {
  target: "/tmp/harness/release-helper",
  appliedHash: "hash",
  change: {
    kind: "write" as const,
    id: "release-helper",
    name: "release-helper",
    content: "skill",
  },
};
const skillsLayer = Layer.succeed(
  HarnessSkills.HarnessSkillsService,
  HarnessSkills.HarnessSkillsService.of({
    discover: () => Effect.succeed([]),
    apply: () => Effect.succeed(skillReceipt),
    rollback: () => Effect.void,
    commit: () => Effect.void,
    recover: () => Effect.void,
  }),
);

const withDb = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      Harness.layer.pipe(
        Layer.provide(skillsLayer),
        Layer.provideMerge(
          Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" }), NodeCrypto.layer),
        ),
      ),
    ),
  );

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE harness_proposals (proposal_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`;
  yield* sql`CREATE TABLE harness_audit (audit_id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, action TEXT NOT NULL, at TEXT NOT NULL, note TEXT, proposal_status TEXT NOT NULL)`;
  yield* sql`CREATE TABLE harness_defaults (scope_key TEXT PRIMARY KEY, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL)`;
  yield* sql`CREATE TABLE harness_analysis_budget (scope_key TEXT NOT NULL, day_key TEXT NOT NULL, analyses INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(scope_key, day_key))`;
  yield* sql`CREATE TABLE harness_analysis_attempts (scope_key TEXT NOT NULL, day_key TEXT NOT NULL, request_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', PRIMARY KEY(scope_key, day_key, request_id))`;
  return yield* Harness.HarnessProposalService;
});

describe("HarnessProposalService", () => {
  it.effect("reports skill usage metrics as unavailable until activity is attributed", () =>
    withDb(
      Effect.gen(function* () {
        const service = yield* setup;
        const inventory = yield* service.inventory({ kind: "global" });
        assert.deepStrictEqual(inventory.usageMetrics, {
          status: "unavailable",
          reason: "skill-usage-not-attributed",
        });
      }),
    ),
  );

  it.effect(
    "round trips provider-independent recommendation targets while retaining staged apply rejection",
    () =>
      withDb(
        Effect.gen(function* () {
          const service = yield* setup;
          const proposal = yield* service.create({
            scope: { kind: "project", projectId: "project:one" },
            operation: "create",
            skillName: "shared-review-practice",
            targetSkillIds: [],
            evidence: ["The same review checks recur across providers."],
            sourceRefs: ["event:1"],
            contentDiff: { before: null, after: null },
            engineId: "native-v1",
            engineVersion: "1",
            confidence: 0.84,
            rationale: "A shared MCP recommendation could reduce repeated setup.",
            target: {
              resourceType: "mcp_recommendation",
              scope: { kind: "project", projectId: "project:one" },
              operation: "create",
              expectedModification: "Recommend a project MCP server for repository inspection.",
              validationCriteria: ["The recommendation applies to at least two providers."],
            },
          });
          const listed = yield* service.list({ scope: proposal.scope });
          assert.deepStrictEqual(listed.proposals[0]?.target, proposal.target);
          assert.strictEqual(proposal.applicationMode, "staged");
          const target = { ...proposal.target!, expectedModification: "Revised recommendation." };
          const revised = yield* service.revise({
            id: proposal.id,
            expectedUpdatedAt: proposal.updatedAt,
            patch: { target },
          });
          assert.deepStrictEqual(revised.target, target);
          const history = yield* service.audit(proposal.id);
          assert.deepStrictEqual(JSON.parse(history[1]!.note!).after.target, target);
          const approved = yield* service.approve(proposal.id);
          const exported = yield* service.export(proposal.id);
          assert.match(exported.filename, /-recommendation\.md$/);
          assert.match(exported.content, /Revised recommendation/);
          const rejectedApply = yield* Effect.flip(service.apply(approved.id));
          assert.strictEqual(rejectedApply._tag, "HarnessError");
        }),
      ),
  );

  it.effect("persists proposals as staged exports and never applies new proposals", () =>
    withDb(
      Effect.gen(function* () {
        const service = yield* setup;
        const proposalInput = {
          scope: { kind: "project", projectId: "project:one" },
          operation: "create",
          skillName: "release-helper",
          targetSkillIds: [],
          evidence: ["Repeated release checklist"],
          sourceRefs: ["event:1"],
          contentDiff: { before: null, after: "---\nname: release-helper\n---\n" },
          engineId: "native-v1",
          engineVersion: "1",
          confidence: 0.9,
          rationale: "Repeated workflow detected.",
          idempotencyKey: "auto:event:1:create::event:1",
        } as const;
        const proposal = yield* service.create(proposalInput);
        assert.strictEqual(proposal.applicationMode, "staged");
        const retried = yield* service.create(proposalInput);
        assert.strictEqual(retried.id, proposal.id);
        assert.strictEqual((yield* service.list({ scope: proposal.scope })).proposals.length, 1);
        const rejectedExport = yield* Effect.flip(service.export(proposal.id));
        assert.strictEqual(rejectedExport._tag, "HarnessError");
        const approved = yield* service.approve(proposal.id, "Reviewed");
        assert.strictEqual(approved.status, "approved");
        assert.deepStrictEqual(yield* service.export(proposal.id), {
          filename: "release-helper.md",
          content: "---\nname: release-helper\n---\n",
        });
        const rejectedApply = yield* Effect.flip(service.apply(proposal.id));
        assert.strictEqual(rejectedApply._tag, "HarnessError");
        assert.deepStrictEqual(
          (yield* service.audit(proposal.id)).map(({ action }) => action),
          ["created", "approved"],
        );
        assert.strictEqual((yield* service.audit()).length, 2);
        const rollback = yield* Effect.flip(service.rollback(proposal.id));
        assert.strictEqual(rollback._tag, "HarnessError");
        const rejectedDecision = yield* Effect.flip(service.reject(proposal.id));
        assert.strictEqual(rejectedDecision._tag, "HarnessError");
      }),
    ),
  );

  it.effect("records explicit external implementation once for approved proposals", () =>
    withDb(
      Effect.gen(function* () {
        const service = yield* setup;
        const proposal = yield* service.create({
          scope: { kind: "global" },
          operation: "create",
          skillName: "external-note",
          targetSkillIds: [],
          evidence: [],
          sourceRefs: [],
          contentDiff: { before: null, after: "proposal" },
          engineId: "native-v1",
          engineVersion: "1",
          confidence: 0.9,
          rationale: "External change",
        });
        const pendingFailure = yield* Effect.flip(service.markImplementedExternally(proposal.id));
        assert.strictEqual(pendingFailure._tag, "HarnessError");
        const approved = yield* service.approve(proposal.id);
        const marked = yield* service.markImplementedExternally(approved.id);
        assert.strictEqual(marked.status, "approved");
        assert.ok(marked.externallyImplementedAt);
        assert.strictEqual(marked.appliedAt, null);
        assert.strictEqual(marked.appliedReceipt, null);
        const repeated = yield* service.markImplementedExternally(approved.id);
        assert.strictEqual(repeated.externallyImplementedAt, marked.externallyImplementedAt);
        const audit = yield* service.audit(approved.id);
        assert.deepStrictEqual(
          audit.map(({ action }) => action),
          ["created", "approved", "implemented_externally"],
        );
        assert.strictEqual(audit[2]?.at, marked.externallyImplementedAt);
      }),
    ),
  );

  it.effect("does not apply approved legacy proposals", () =>
    withDb(
      Effect.gen(function* () {
        const service = yield* setup;
        const sql = yield* SqlClient.SqlClient;
        const legacy = {
          id: "legacy-pending",
          scope: { kind: "global" },
          operation: "create",
          skillName: "legacy",
          targetSkillIds: [],
          evidence: [],
          sourceRefs: [],
          contentDiff: { before: null, after: "legacy content" },
          engineId: "native-v1",
          engineVersion: "1",
          confidence: 0.9,
          rationale: "Historical proposal",
          status: "pending",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          decidedAt: null,
          decisionNote: null,
          appliedAt: null,
          appliedReceipt: null,
        };
        yield* sql`INSERT INTO harness_proposals (proposal_id, scope_key, status, payload_json, created_at, updated_at)
          VALUES ('legacy-pending', 'global', 'pending', ${JSON.stringify(legacy)}, '2026-01-01', '2026-01-01')`;
        yield* service.approve(legacy.id);
        assert.strictEqual((yield* service.export(legacy.id)).content, "legacy content");
        const failure = yield* Effect.flip(service.apply(legacy.id));
        assert.strictEqual(failure._tag, "HarnessError");
        assert.deepStrictEqual(
          (yield* service.audit(legacy.id)).map(({ action }) => action),
          ["approved"],
        );
      }),
    ),
  );

  it.effect("keeps receipt-backed rollback available for pre-staging records", () =>
    withDb(
      Effect.gen(function* () {
        const service = yield* setup;
        const sql = yield* SqlClient.SqlClient;
        const legacy = {
          id: "legacy-applied",
          scope: { kind: "global" },
          operation: "create",
          skillName: "legacy",
          targetSkillIds: [],
          evidence: [],
          sourceRefs: [],
          contentDiff: { before: null, after: "legacy content" },
          engineId: "native-v1",
          engineVersion: "1",
          confidence: 0.9,
          rationale: "Historical proposal",
          status: "applied",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          decidedAt: "2026-01-01T00:00:00.000Z",
          decisionNote: null,
          appliedAt: "2026-01-01T00:00:00.000Z",
          appliedReceipt: skillReceipt,
        };
        yield* sql`INSERT INTO harness_proposals (proposal_id, scope_key, status, payload_json, created_at, updated_at)
          VALUES ('legacy-applied', 'global', 'applied', ${JSON.stringify(legacy)}, '2026-01-01', '2026-01-01')`;
        const rolledBack = yield* service.rollback("legacy-applied");
        assert.strictEqual(rolledBack.status, "approved");
        assert.strictEqual(rolledBack.applicationMode, undefined);
      }),
    ),
  );

  it.effect(
    "revises pending proposals with validation, optimistic concurrency, and a history snapshot",
    () =>
      withDb(
        Effect.gen(function* () {
          const service = yield* setup;
          const proposal = yield* service.create({
            scope: { kind: "global" },
            operation: "create",
            skillName: "release-helper",
            targetSkillIds: [],
            evidence: ["Repeated release checklist"],
            sourceRefs: ["event:1"],
            contentDiff: { before: null, after: "---\nname: release-helper\n---\n" },
            engineId: "native-v1",
            engineVersion: "1",
            confidence: 0.7,
            rationale: "Initial rationale.",
          });
          const revised = yield* service.revise({
            id: proposal.id,
            expectedUpdatedAt: proposal.updatedAt,
            patch: { confidence: 0.95, rationale: "Reviewed and improved." },
          });
          assert.notStrictEqual(revised.updatedAt, proposal.updatedAt);
          assert.strictEqual(revised.confidence, 0.95);
          assert.strictEqual(revised.rationale, "Reviewed and improved.");
          assert.strictEqual(revised.status, "pending");
          assert.strictEqual(revised.appliedReceipt, null);
          const history = yield* service.audit(proposal.id);
          assert.deepStrictEqual(
            history.map(({ action }) => action),
            ["created", "revised"],
          );
          const snapshot = JSON.parse(history[1]!.note!) as {
            before: { confidence: number; rationale: string };
            after: { confidence: number; rationale: string };
          };
          assert.strictEqual(snapshot.before.confidence, 0.7);
          assert.strictEqual(snapshot.before.rationale, "Initial rationale.");
          assert.strictEqual(snapshot.after.confidence, 0.95);
          assert.strictEqual(snapshot.after.rationale, "Reviewed and improved.");
          const stale = yield* Effect.flip(
            service.revise({
              id: proposal.id,
              expectedUpdatedAt: proposal.updatedAt,
              patch: { rationale: "Stale write." },
            }),
          );
          assert.strictEqual(stale._tag, "HarnessError");
          const invalid = yield* Effect.flip(
            service.revise({
              id: proposal.id,
              expectedUpdatedAt: revised.updatedAt,
              patch: { confidence: 1.5 },
            }),
          );
          assert.strictEqual(invalid._tag, "HarnessError");
          assert.strictEqual((yield* service.audit(proposal.id)).length, 2);
          const approved = yield* service.approve(proposal.id);
          const locked = yield* Effect.flip(
            service.revise({
              id: proposal.id,
              expectedUpdatedAt: approved.updatedAt,
              patch: { rationale: "Cannot alter after decision." },
            }),
          );
          assert.strictEqual(locked._tag, "HarnessError");
        }),
      ),
  );

  it.effect("validates confidence and keeps project defaults scoped with global fallback", () =>
    withDb(
      Effect.gen(function* () {
        const service = yield* setup;
        const defaults = yield* service.getDefaults({ kind: "project", projectId: "project:one" });
        assert.strictEqual(defaults.enabled, true);
        assert.strictEqual(defaults.minimumConfidence, 0.75);
        yield* service.setDefaults({
          scope: { kind: "global" },
          enabled: true,
          autoLearn: true,
          engineId: "native-v1",
          modelSelection: null,
          dailyAnalysisBudget: 10,
          minimumConfidence: 0.8,
        });
        const inherited = yield* service.getDefaults({ kind: "project", projectId: "project:one" });
        assert.strictEqual(inherited.enabled, true);
        assert.strictEqual(inherited.scope.kind, "project");
        const scope = { kind: "project" as const, projectId: "project:one" };
        assert.deepStrictEqual(
          yield* service.consumeAnalysisBudget(scope, 2, "2026-10-27", "event:1"),
          { allowed: true, isNew: true, shouldRun: true },
        );
        assert.deepStrictEqual(
          yield* service.consumeAnalysisBudget(scope, 2, "2026-10-27", "event:1"),
          { allowed: true, isNew: false, shouldRun: true },
        );
        yield* service.completeAnalysisAttempt(scope, "event:1");
        assert.deepStrictEqual(
          yield* service.consumeAnalysisBudget(scope, 2, "2026-10-27", "event:1"),
          { allowed: true, isNew: false, shouldRun: false },
        );
        assert.deepStrictEqual(
          yield* service.consumeAnalysisBudget(scope, 2, "2026-10-27", "event:2"),
          { allowed: true, isNew: true, shouldRun: true },
        );
        assert.deepStrictEqual(
          yield* service.consumeAnalysisBudget(scope, 2, "2026-10-27", "event:3"),
          { allowed: false, isNew: false, shouldRun: false },
        );
        assert.deepStrictEqual(
          yield* service.consumeAnalysisBudget(scope, 2, "2026-10-28", "event:3"),
          { allowed: true, isNew: true, shouldRun: true },
        );
        const budget = yield* service.getAnalysisBudget({ kind: "global" });
        assert.isAtLeast(budget.remaining, 0);
        const invalid = yield* Effect.flip(
          service.setDefaults({
            scope: { kind: "global" },
            enabled: true,
            autoLearn: true,
            engineId: "native-v1",
            modelSelection: null,
            dailyAnalysisBudget: 10,
            minimumConfidence: 1.1,
          }),
        );
        assert.strictEqual(invalid._tag, "HarnessError");
      }),
    ),
  );
});
