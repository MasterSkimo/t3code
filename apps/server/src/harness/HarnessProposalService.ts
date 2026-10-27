import {
  HarnessAnalysisBudget,
  HarnessDefaults,
  HarnessDefaultsSetInput,
  HarnessError,
  HarnessProposal,
  HarnessProposalCreateInput,
  HarnessProposalListInput,
  HarnessProposalListResult,
  type HarnessProposal as Proposal,
  type HarnessSkillReceipt,
  type HarnessAuditEntry as AuditEntry,
  type HarnessDefaults as Defaults,
  type HarnessSkillInventory as SkillInventory,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as HarnessSkills from "./HarnessSkillsService.ts";
import type { SkillChangeReceipt } from "./skills.ts";

const decodeProposal = Schema.decodeUnknownSync(Schema.fromJsonString(HarnessProposal));
const encodeProposal = Schema.encodeSync(Schema.fromJsonString(HarnessProposal));
const decodeDefaults = Schema.decodeUnknownSync(Schema.fromJsonString(HarnessDefaults));
const encodeDefaults = Schema.encodeSync(Schema.fromJsonString(HarnessDefaults));
const isHarnessError = Schema.is(HarnessError);
const scopeKey = (scope: HarnessProposal["scope"]) =>
  scope.kind === "global" ? "global" : `project:${scope.projectId}`;

export class HarnessProposalService extends Context.Service<
  HarnessProposalService,
  {
    readonly create: (input: HarnessProposalCreateInput) => Effect.Effect<Proposal, HarnessError>;
    readonly list: (
      input: HarnessProposalListInput,
    ) => Effect.Effect<HarnessProposalListResult, HarnessError>;
    readonly approve: (id: string, note?: string) => Effect.Effect<Proposal, HarnessError>;
    readonly reject: (id: string, note?: string) => Effect.Effect<Proposal, HarnessError>;
    readonly apply: (id: string) => Effect.Effect<Proposal, HarnessError>;
    readonly rollback: (id: string) => Effect.Effect<Proposal, HarnessError>;
    readonly recoverInterrupted: () => Effect.Effect<void, HarnessError>;
    readonly audit: (proposalId?: string) => Effect.Effect<ReadonlyArray<AuditEntry>, HarnessError>;
    readonly inventory: (
      scope: HarnessProposal["scope"],
    ) => Effect.Effect<SkillInventory, HarnessError>;
    readonly getDefaults: (
      scope: HarnessProposal["scope"],
    ) => Effect.Effect<Defaults, HarnessError>;
    readonly setDefaults: (input: HarnessDefaultsSetInput) => Effect.Effect<Defaults, HarnessError>;
    readonly consumeAnalysisBudget: (
      scope: HarnessProposal["scope"],
      dailyLimit: number,
      dayKey: string,
      requestId?: string,
    ) => Effect.Effect<{ readonly allowed: boolean; readonly isNew: boolean }, HarnessError>;
    readonly getAnalysisBudget: (
      scope: HarnessProposal["scope"],
    ) => Effect.Effect<HarnessAnalysisBudget, HarnessError>;
  }
>()("t3/harness/HarnessProposalService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const skills = yield* HarnessSkills.HarnessSkillsService;
  const id = () => crypto.randomUUIDv4().pipe(Effect.orDie);
  const now = () => Effect.map(DateTime.now, (date) => DateTime.formatIso(DateTime.toUtc(date)));
  const error = (message: string, proposalId?: string) =>
    new HarnessError({ message, ...(proposalId === undefined ? {} : { proposalId }) });
  const toSkillReceipt = (receipt: HarnessSkillReceipt) => receipt as unknown as SkillChangeReceipt;
  const toContractReceipt = (receipt: SkillChangeReceipt) =>
    receipt as unknown as HarnessSkillReceipt;
  const publicProposal = (proposal: Proposal): Proposal => ({ ...proposal, appliedReceipt: null });

  const read = Effect.fn("HarnessProposalService.read")(function* (proposalId: string) {
    const rows = yield* sql<{
      readonly payload_json: string;
    }>`SELECT payload_json FROM harness_proposals WHERE proposal_id = ${proposalId}`.pipe(
      Effect.mapError(() => error("Could not read Harness proposal.", proposalId)),
    );
    if (!rows[0]) return yield* error("Harness proposal was not found.", proposalId);
    return yield* Effect.try({
      try: () => decodeProposal(rows[0]!.payload_json),
      catch: () => error("Saved Harness proposal is invalid.", proposalId),
    });
  });

  const addAudit = (
    proposal: Proposal,
    action:
      | "created"
      | "approved"
      | "rejected"
      | "apply_started"
      | "apply_recovered"
      | "applied"
      | "rollback_started"
      | "rolled_back",
    note: string | null,
    at: string,
  ) =>
    Effect.flatMap(id(), (auditId) =>
      sql`
      INSERT INTO harness_audit (audit_id, proposal_id, action, at, note, proposal_status)
      VALUES (${auditId}, ${proposal.id}, ${action}, ${at}, ${note}, ${proposal.status})
    `.pipe(Effect.mapError(() => error("Could not record Harness audit entry.", proposal.id))),
    );

  const create: HarnessProposalService["Service"]["create"] = Effect.fn(
    "HarnessProposalService.create",
  )(function* (input) {
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)
      return yield* error("Proposal confidence must be between 0 and 1.");
    const targetIds = new Set(input.targetSkillIds);
    if (
      targetIds.size !== input.targetSkillIds.length ||
      input.targetSkillIds.some((value) => !value.trim())
    )
      return yield* error("Proposal target skill ids must be unique and non-empty.");
    if (
      input.operation === "create" &&
      (input.targetSkillIds.length !== 0 ||
        input.contentDiff.before !== null ||
        input.contentDiff.after === null)
    )
      return yield* error("Create proposals need new content and cannot target an existing skill.");
    if (input.operation !== "create" && input.targetSkillIds.length === 0)
      return yield* error("This proposal operation requires a target skill.");
    if (
      input.operation === "archive" &&
      (input.contentDiff.before === null || input.contentDiff.after !== null)
    )
      return yield* error(
        "Archive proposals need the existing content and cannot include replacement content.",
      );
    if (
      (input.operation === "update" || input.operation === "merge") &&
      (input.contentDiff.before === null || input.contentDiff.after === null)
    )
      return yield* error("Update and merge proposals need both before and replacement content.");
    if (!input.skillName.trim() || input.skillName.length > 120)
      return yield* error("Proposal skill name must be non-empty and at most 120 characters.");
    const createdAt = yield* now();
    const proposalId = yield* id();
    const proposal: Proposal = {
      ...input,
      id: proposalId,
      status: "pending",
      createdAt,
      updatedAt: createdAt,
      decidedAt: null,
      decisionNote: null,
      appliedAt: null,
      appliedReceipt: null,
    };
    const payload = encodeProposal(proposal);
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
        INSERT INTO harness_proposals (proposal_id, scope_key, status, payload_json, created_at, updated_at)
        VALUES (${proposal.id}, ${scopeKey(proposal.scope)}, ${proposal.status}, ${payload}, ${createdAt}, ${createdAt})
      `.pipe(Effect.mapError(() => error("Could not save Harness proposal.", proposal.id)));
          yield* addAudit(proposal, "created", null, createdAt);
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isHarnessError(cause) ? cause : error("Could not save Harness proposal.", proposal.id),
        ),
      );
    return publicProposal(proposal);
  });

  const list: HarnessProposalService["Service"]["list"] = Effect.fn("HarnessProposalService.list")(
    function* (input) {
      const rows = yield* (
        input.scope === undefined
          ? input.status === undefined
            ? sql<{
                readonly payload_json: string;
              }>`SELECT payload_json FROM harness_proposals ORDER BY updated_at DESC`
            : sql<{
                readonly payload_json: string;
              }>`SELECT payload_json FROM harness_proposals WHERE status = ${input.status} ORDER BY updated_at DESC`
          : input.status === undefined
            ? sql<{
                readonly payload_json: string;
              }>`SELECT payload_json FROM harness_proposals WHERE scope_key = ${scopeKey(input.scope)} ORDER BY updated_at DESC`
            : sql<{
                readonly payload_json: string;
              }>`SELECT payload_json FROM harness_proposals WHERE scope_key = ${scopeKey(input.scope)} AND status = ${input.status} ORDER BY updated_at DESC`
      ).pipe(Effect.mapError(() => error("Could not list Harness proposals.")));
      const proposals = yield* Effect.forEach(rows, (row) =>
        Effect.try({
          try: () => decodeProposal(row.payload_json),
          catch: () => error("Saved Harness proposal is invalid."),
        }),
      );
      return { proposals: proposals.map(publicProposal) };
    },
  );

  const transition = (action: "approved" | "rejected", id: string, note?: string) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const current = yield* read(id);
          if (current.status !== "pending")
            return yield* error("Only pending proposals can be decided.", id);
          const at = yield* now();
          const next: Proposal = {
            ...current,
            status: action,
            updatedAt: at,
            decidedAt: at,
            decisionNote: note ?? null,
            appliedAt: current.appliedAt,
            appliedReceipt: current.appliedReceipt,
          };
          const updated =
            yield* sql`UPDATE harness_proposals SET status = ${next.status}, payload_json = ${encodeProposal(next)}, updated_at = ${at} WHERE proposal_id = ${id} AND status = ${current.status} RETURNING proposal_id`.pipe(
              Effect.mapError(() => error("Could not update Harness proposal.", id)),
            );
          if (updated.length === 0)
            return yield* error("Harness proposal changed while it was being updated.", id);
          yield* addAudit(next, action, note ?? null, at);
          return next;
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isHarnessError(cause) ? cause : error("Could not update Harness proposal.", id),
        ),
      );

  const audit: HarnessProposalService["Service"]["audit"] = Effect.fn(
    "HarnessProposalService.audit",
  )(function* (proposalId) {
    if (proposalId !== undefined) yield* read(proposalId);
    const rows = yield* (
      proposalId === undefined
        ? sql<AuditEntry>`SELECT audit_id as id, proposal_id as proposalId, action, at, note, proposal_status as proposalStatus FROM harness_audit ORDER BY rowid ASC`
        : sql<AuditEntry>`SELECT audit_id as id, proposal_id as proposalId, action, at, note, proposal_status as proposalStatus FROM harness_audit WHERE proposal_id = ${proposalId} ORDER BY rowid ASC`
    ).pipe(Effect.mapError(() => error("Could not read Harness audit history.", proposalId)));
    return rows.map((row) => ({ ...row, note: row.note ?? null }));
  });

  const inventory: HarnessProposalService["Service"]["inventory"] = Effect.fn(
    "HarnessProposalService.inventory",
  )(function* (scope) {
    const skillsList = yield* skills.discover(scope);
    return {
      skills: skillsList.map(({ id, name, description, scope: skillScope, managed }) => ({
        id,
        name,
        ...(description === undefined ? {} : { description }),
        scope: skillScope,
        managed,
      })),
    };
  });

  const apply: HarnessProposalService["Service"]["apply"] = Effect.fn(
    "HarnessProposalService.apply",
  )(function* (proposalId) {
    const proposal = yield* read(proposalId);
    if (proposal.status !== "approved")
      return yield* error("Only approved proposals can be applied.", proposalId);
    const startingAt = yield* now();
    const applying: Proposal = { ...proposal, status: "applying", updatedAt: startingAt };
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const changed =
            yield* sql`UPDATE harness_proposals SET status = 'applying', payload_json = ${encodeProposal(applying)}, updated_at = ${startingAt} WHERE proposal_id = ${proposalId} AND status = 'approved' RETURNING proposal_id`.pipe(
              Effect.mapError(() =>
                error("Could not start Harness skill application.", proposalId),
              ),
            );
          if (changed.length === 0)
            return yield* error("Harness proposal changed while it was being applied.", proposalId);
          yield* addAudit(applying, "apply_started", null, startingAt);
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isHarnessError(cause)
            ? cause
            : error("Could not start Harness skill application.", proposalId),
        ),
      );
    const receipt = yield* skills.apply({ ...proposal, status: "approved" });
    const at = yield* now();
    const next: Proposal = {
      ...proposal,
      status: "applied",
      appliedAt: at,
      appliedReceipt: toContractReceipt(receipt),
      updatedAt: at,
    };
    const persisted = yield* Effect.exit(
      sql
        .withTransaction(
          Effect.gen(function* () {
            const changed =
              yield* sql`UPDATE harness_proposals SET status = 'applied', payload_json = ${encodeProposal(next)}, updated_at = ${at} WHERE proposal_id = ${proposalId} AND status = 'applying' RETURNING proposal_id`.pipe(
                Effect.mapError(() =>
                  error("Could not record Harness skill application.", proposalId),
                ),
              );
            if (changed.length === 0)
              return yield* error(
                "Harness proposal changed while it was being applied.",
                proposalId,
              );
            yield* addAudit(next, "applied", null, at);
            return next;
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isHarnessError(cause)
              ? cause
              : error("Could not record Harness skill application.", proposalId),
          ),
        ),
    );
    if (Exit.isFailure(persisted)) {
      yield* skills.rollback(proposal.scope, toSkillReceipt(receipt));
      return yield* Effect.failCause(persisted.cause);
    }
    yield* skills.commit(proposal.scope, toSkillReceipt(receipt));
    return publicProposal(persisted.value);
  });

  const rollback: HarnessProposalService["Service"]["rollback"] = Effect.fn(
    "HarnessProposalService.rollback",
  )(function* (proposalId) {
    const proposal = yield* read(proposalId);
    if (proposal.status !== "applied" || !proposal.appliedReceipt)
      return yield* error(
        "Only applied proposals with a saved rollback receipt can be rolled back.",
        proposalId,
      );
    const receipt = toSkillReceipt(proposal.appliedReceipt);
    const startingAt = yield* now();
    const rollingBack: Proposal = { ...proposal, status: "rolling_back", updatedAt: startingAt };
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const changed =
            yield* sql`UPDATE harness_proposals SET status = 'rolling_back', payload_json = ${encodeProposal(rollingBack)}, updated_at = ${startingAt} WHERE proposal_id = ${proposalId} AND status = 'applied' RETURNING proposal_id`.pipe(
              Effect.mapError(() => error("Could not start Harness rollback.", proposalId)),
            );
          if (changed.length === 0)
            return yield* error(
              "Harness proposal changed while it was being rolled back.",
              proposalId,
            );
          yield* addAudit(rollingBack, "rollback_started", null, startingAt);
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isHarnessError(cause) ? cause : error("Could not start Harness rollback.", proposalId),
        ),
      );
    yield* skills.rollback(proposal.scope, receipt);
    const at = yield* now();
    const next: Proposal = {
      ...proposal,
      status: "approved",
      appliedAt: null,
      appliedReceipt: null,
      updatedAt: at,
    };
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const changed =
            yield* sql`UPDATE harness_proposals SET status = 'approved', payload_json = ${encodeProposal(next)}, updated_at = ${at} WHERE proposal_id = ${proposalId} AND status = 'rolling_back' RETURNING proposal_id`.pipe(
              Effect.mapError(() => error("Could not record Harness rollback.", proposalId)),
            );
          if (changed.length === 0)
            return yield* error(
              "Harness proposal changed while it was being rolled back.",
              proposalId,
            );
          yield* addAudit(next, "rolled_back", null, at);
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isHarnessError(cause) ? cause : error("Could not record Harness rollback.", proposalId),
        ),
      );
    return next;
  });

  const recoverInterrupted: HarnessProposalService["Service"]["recoverInterrupted"] = Effect.fn(
    "HarnessProposalService.recoverInterrupted",
  )(function* () {
    const rows = yield* sql<{
      readonly payload_json: string;
    }>`SELECT payload_json FROM harness_proposals WHERE status IN ('applying', 'rolling_back', 'applied')`.pipe(
      Effect.mapError(() => error("Could not read interrupted Harness proposals.")),
    );
    const proposals = yield* Effect.forEach(rows, (row) =>
      Effect.try({
        try: () => decodeProposal(row.payload_json),
        catch: () => error("Saved Harness proposal is invalid."),
      }),
    );
    for (const proposal of proposals) {
      if (proposal.status === "applying") {
        yield* skills.recover(proposal.scope, proposal.id);
        const at = yield* now();
        const recovered: Proposal = { ...proposal, status: "approved", updatedAt: at };
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const changed =
                yield* sql`UPDATE harness_proposals SET status = 'approved', payload_json = ${encodeProposal(recovered)}, updated_at = ${at} WHERE proposal_id = ${proposal.id} AND status = 'applying' RETURNING proposal_id`.pipe(
                  Effect.mapError(() =>
                    error("Could not recover interrupted Harness application.", proposal.id),
                  ),
                );
              if (changed.length === 0) return;
              yield* addAudit(recovered, "apply_recovered", null, at);
            }),
          )
          .pipe(
            Effect.mapError((cause) =>
              isHarnessError(cause)
                ? cause
                : error("Could not recover interrupted Harness application.", proposal.id),
            ),
          );
      } else if (proposal.status === "rolling_back" && proposal.appliedReceipt) {
        yield* skills.rollback(proposal.scope, toSkillReceipt(proposal.appliedReceipt));
        const at = yield* now();
        const recovered: Proposal = {
          ...proposal,
          status: "approved",
          appliedAt: null,
          appliedReceipt: null,
          updatedAt: at,
        };
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const changed =
                yield* sql`UPDATE harness_proposals SET status = 'approved', payload_json = ${encodeProposal(recovered)}, updated_at = ${at} WHERE proposal_id = ${proposal.id} AND status = 'rolling_back' RETURNING proposal_id`.pipe(
                  Effect.mapError(() =>
                    error("Could not recover interrupted Harness rollback.", proposal.id),
                  ),
                );
              if (changed.length === 0) return;
              yield* addAudit(recovered, "rolled_back", "Recovered after interruption.", at);
            }),
          )
          .pipe(
            Effect.mapError((cause) =>
              isHarnessError(cause)
                ? cause
                : error("Could not recover interrupted Harness rollback.", proposal.id),
            ),
          );
      } else if (proposal.status === "applied" && proposal.appliedReceipt) {
        yield* skills.commit(proposal.scope, toSkillReceipt(proposal.appliedReceipt));
      }
    }
  });

  const getDefaults: HarnessProposalService["Service"]["getDefaults"] = Effect.fn(
    "HarnessProposalService.getDefaults",
  )(function* (scope) {
    const key = scopeKey(scope);
    const rows = yield* sql<{
      readonly payload_json: string;
    }>`SELECT payload_json FROM harness_defaults WHERE scope_key = ${key}`.pipe(
      Effect.mapError(() => error("Could not read Harness defaults.")),
    );
    if (rows[0])
      return yield* Effect.try({
        try: () => decodeDefaults(rows[0]!.payload_json),
        catch: () => error("Saved Harness defaults are invalid."),
      });
    if (scope.kind === "project") {
      const global = yield* sql<{
        readonly payload_json: string;
      }>`SELECT payload_json FROM harness_defaults WHERE scope_key = 'global'`.pipe(
        Effect.mapError(() => error("Could not read Harness defaults.")),
      );
      if (global[0])
        return yield* Effect.try({
          try: () => ({ ...decodeDefaults(global[0]!.payload_json), scope }),
          catch: () => error("Saved Harness defaults are invalid."),
        });
    }
    return {
      scope,
      enabled: true,
      autoLearn: true,
      engineId: "native-v1",
      modelSelection: null,
      dailyAnalysisBudget: 10,
      minimumConfidence: 0.75,
      updatedAt: "",
    };
  });

  const setDefaults: HarnessProposalService["Service"]["setDefaults"] = Effect.fn(
    "HarnessProposalService.setDefaults",
  )(function* (input) {
    if (
      !Number.isFinite(input.minimumConfidence) ||
      input.minimumConfidence < 0 ||
      input.minimumConfidence > 1
    )
      return yield* error("Minimum confidence must be between 0 and 1.");
    if (
      !Number.isInteger(input.dailyAnalysisBudget) ||
      input.dailyAnalysisBudget < 0 ||
      input.dailyAnalysisBudget > 1000
    )
      return yield* error("Daily analysis budget must be an integer from 0 to 1000.");
    if (!input.engineId.trim() || input.engineId.length > 100)
      return yield* error("Harness engine id must be non-empty and at most 100 characters.");
    const updatedAt = yield* now();
    const value = { ...input, updatedAt };
    yield* sql`INSERT INTO harness_defaults (scope_key, payload_json, updated_at) VALUES (${scopeKey(input.scope)}, ${encodeDefaults(value)}, ${updatedAt}) ON CONFLICT(scope_key) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`.pipe(
      Effect.mapError(() => error("Could not save Harness defaults.")),
    );
    return value;
  });

  const consumeAnalysisBudget: HarnessProposalService["Service"]["consumeAnalysisBudget"] =
    Effect.fn("HarnessProposalService.consumeAnalysisBudget")(
      function* (scope, dailyLimit, dayKey, requestId) {
        if (!Number.isInteger(dailyLimit) || dailyLimit < 0 || dailyLimit > 1000)
          return yield* error("Daily analysis budget must be an integer from 0 to 1000.");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey))
          return yield* error("Analysis budget day must use YYYY-MM-DD.");
        if (requestId !== undefined && (!requestId.trim() || requestId.length > 256))
          return yield* error("Analysis request id must be non-empty and at most 256 characters.");
        if (dailyLimit === 0) return { allowed: false, isNew: false };
        const attemptId = requestId ?? (yield* id());
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const inserted = yield* sql<{ readonly request_id: string }>`
        INSERT INTO harness_analysis_attempts (scope_key, day_key, request_id)
        VALUES (${scopeKey(scope)}, ${dayKey}, ${attemptId})
        ON CONFLICT(scope_key, day_key, request_id) DO NOTHING
        RETURNING request_id
      `.pipe(Effect.mapError(() => error("Could not record Harness analysis attempt.")));
              if (inserted.length === 0) return { allowed: true, isNew: false };
              const consumed = yield* sql<{ readonly analyses: number }>`
        INSERT INTO harness_analysis_budget (scope_key, day_key, analyses)
        VALUES (${scopeKey(scope)}, ${dayKey}, 1)
        ON CONFLICT(scope_key, day_key) DO UPDATE SET analyses = harness_analysis_budget.analyses + 1
        WHERE harness_analysis_budget.analyses < ${dailyLimit}
        RETURNING analyses
      `.pipe(Effect.mapError(() => error("Could not update Harness analysis budget.")));
              if (consumed.length > 0) return { allowed: true, isNew: true };
              yield* sql`DELETE FROM harness_analysis_attempts WHERE scope_key = ${scopeKey(scope)} AND day_key = ${dayKey} AND request_id = ${attemptId}`.pipe(
                Effect.mapError(() => error("Could not release Harness analysis attempt.")),
              );
              return { allowed: false, isNew: false };
            }),
          )
          .pipe(
            Effect.mapError((cause) =>
              isHarnessError(cause) ? cause : error("Could not update Harness analysis budget."),
            ),
          );
      },
    );

  const getAnalysisBudget: HarnessProposalService["Service"]["getAnalysisBudget"] = Effect.fn(
    "HarnessProposalService.getAnalysisBudget",
  )(function* (scope) {
    const defaults = yield* getDefaults(scope);
    const dayKey = DateTime.formatIso(DateTime.toUtc(yield* DateTime.now)).slice(0, 10);
    const rows = yield* sql<{
      readonly analyses: number;
    }>`SELECT analyses FROM harness_analysis_budget WHERE scope_key = ${scopeKey(scope)} AND day_key = ${dayKey}`.pipe(
      Effect.mapError(() => error("Could not read Harness analysis budget.")),
    );
    const used = rows[0]?.analyses ?? 0;
    return {
      scope,
      dayKey,
      dailyLimit: defaults.dailyAnalysisBudget,
      used,
      remaining: Math.max(0, defaults.dailyAnalysisBudget - used),
    };
  });

  return HarnessProposalService.of({
    create,
    list,
    approve: Effect.fn("HarnessProposalService.approve")(function* (id, note) {
      return yield* transition("approved", id, note);
    }),
    reject: Effect.fn("HarnessProposalService.reject")(function* (id, note) {
      return yield* transition("rejected", id, note);
    }),
    apply,
    rollback,
    recoverInterrupted,
    audit,
    inventory,
    getDefaults,
    setDefaults,
    consumeAnalysisBudget,
    getAnalysisBudget,
  });
});

export const layer = Layer.effect(HarnessProposalService, make);
