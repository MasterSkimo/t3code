import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { PlotlineDag, PlotlineDagRecordVerificationInput } from "./plotlineDag.ts";

const decodeVerification = Schema.decodeUnknownSync(PlotlineDagRecordVerificationInput);
const decodeDag = Schema.decodeUnknownSync(PlotlineDag);

describe("Plotline verification contracts", () => {
  it("accepts bounded verification records and positive integer versions", () => {
    expect(
      decodeVerification({
        dagId: "dag",
        taskId: "task",
        attemptId: " attempt-1 ",
        verdict: "pass",
        summary: " verified ",
        criterionResults: [{ criterionId: "criterion-1", verdict: "pass", evidence: "ok" }],
      }),
    ).toMatchObject({ attemptId: "attempt-1", summary: "verified" });
    expect(() =>
      decodeDag({
        id: "dag",
        projectId: "project",
        title: "legacy",
        description: "",
        workspace: null,
        state: "waiting",
        createdAt: "now",
        updatedAt: "now",
        startedAt: null,
        finishedAt: null,
        events: [],
        tasks: [
          {
            id: "task",
            title: "legacy",
            description: "",
            state: "pending",
            effort: 1,
            dependsOn: [],
            threadId: null,
            runId: null,
            legacySessionIds: [],
            agent: null,
            createdAt: "now",
            updatedAt: "now",
            startedAt: null,
            finishedAt: null,
            criteriaVersion: 1,
            acceptanceCriteria: [{ id: "c1", description: "check" }],
            verificationAttempts: [
              {
                id: "v1",
                attemptId: "a1",
                verdict: "pass",
                summary: "ok",
                criterionResults: [{ criterionId: "c1", verdict: "pass", evidence: "ok" }],
                criteriaVersion: 1,
                createdAt: "now",
              },
            ],
          },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects empty or oversized verification identifiers, invalid versions, and oversized collections", () => {
    const base = {
      dagId: "dag",
      taskId: "task",
      attemptId: "a1",
      verdict: "pass" as const,
      summary: "ok",
      criterionResults: [],
    };
    expect(() => decodeVerification({ ...base, attemptId: "  " })).toThrow();
    expect(() => decodeVerification({ ...base, attemptId: "a".repeat(129) })).toThrow();
    for (const criteriaVersion of [0, -1, 1.5]) {
      expect(() =>
        decodeDag({
          id: "dag",
          projectId: "project",
          title: "legacy",
          description: "",
          workspace: null,
          state: "waiting",
          createdAt: "now",
          updatedAt: "now",
          startedAt: null,
          finishedAt: null,
          events: [],
          tasks: [
            {
              id: "task",
              title: "legacy",
              description: "",
              state: "pending",
              effort: 1,
              dependsOn: [],
              threadId: null,
              runId: null,
              legacySessionIds: [],
              agent: null,
              createdAt: "now",
              updatedAt: "now",
              startedAt: null,
              finishedAt: null,
              criteriaVersion,
            },
          ],
        }),
      ).toThrow();
    }
    expect(() =>
      decodeVerification({
        ...base,
        criterionResults: Array.from({ length: 101 }, (_, index) => ({
          criterionId: `c${index}`,
          verdict: "pass",
          evidence: "ok",
        })),
      }),
    ).toThrow();
  });

  it("continues decoding legacy tasks without verification fields", () => {
    expect(() =>
      decodeDag({
        id: "dag",
        projectId: "project",
        title: "legacy",
        description: "",
        workspace: null,
        state: "waiting",
        createdAt: "now",
        updatedAt: "now",
        startedAt: null,
        finishedAt: null,
        events: [],
        tasks: [
          {
            id: "task",
            title: "legacy",
            description: "",
            state: "pending",
            effort: 1,
            dependsOn: [],
            threadId: null,
            runId: null,
            legacySessionIds: [],
            agent: null,
            createdAt: "now",
            updatedAt: "now",
            startedAt: null,
            finishedAt: null,
          },
        ],
      }),
    ).not.toThrow();
  });
});
