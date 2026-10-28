import {
  OrchestrationV2DomainEvent,
  PlotlineDag,
  type OrchestrationV2DomainEvent as DomainEvent,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "@effect/vitest";
import { collectSignificantEvents, makeSignificantEventCollector } from "./events.ts";

const decodeEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEvent);
const decodeDag = Schema.decodeUnknownSync(PlotlineDag);
const now = DateTime.makeUnsafe("2026-10-27T12:00:00.000Z");
const later = DateTime.makeUnsafe("2026-10-27T12:01:00.000Z");

const message = (id: string, text: string, role: "user" | "assistant", runId: string | null) =>
  decodeEvent({
    id: `event_${id}`,
    type: "message.updated",
    threadId: "thread_test",
    occurredAt: now,
    payload: {
      id: `message_${id}`,
      threadId: "thread_test",
      runId,
      nodeId: null,
      role,
      text,
      attachments: [],
      streaming: false,
      createdAt: now,
      updatedAt: now,
      createdBy: role === "user" ? "user" : "agent",
      creationSource: role === "user" ? "web" : "provider",
    },
  }) as Extract<DomainEvent, { type: "message.updated" }>;

const run = (id: string, status: "completed" | "failed") =>
  decodeEvent({
    id: `event_${id}_${status}`,
    type: "run.updated",
    threadId: "thread_test",
    runId: id,
    occurredAt: later,
    payload: {
      id,
      threadId: "thread_test",
      ordinal: 1,
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "test" },
      providerThreadId: null,
      userMessageId: "message_user",
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: now,
      startedAt: now,
      completedAt: later,
      checkpointId: null,
      contextHandoffId: null,
    },
  }) as Extract<DomainEvent, { type: "run.updated" }>;

describe("collectSignificantEvents", () => {
  it("collects corrections, repeated requests, successful output and failures with stable refs", () => {
    const user = message("user", "Please fix the wrong output", "user", null);
    const repeatedA = message("repeat-a", "Build the dashboard", "user", null);
    const repeatedB = message("repeat-b", "Build the dashboard", "user", null);
    const answer = message("answer", "Dashboard completed", "assistant", "run:success");
    const events = collectSignificantEvents([
      user,
      repeatedA,
      repeatedB,
      answer,
      run("run:success", "completed"),
      run("run:failed", "failed"),
    ]);

    expect(events.map((event) => event.type)).toEqual([
      "user_feedback",
      "repeated_workflow",
      "successful_output",
      "failure",
    ]);
    expect(events[0]?.sourceRefs).toContain("message_user");
    expect(events[2]?.evidence).toContain("Dashboard completed");
    expect(
      collectSignificantEvents([
        user,
        repeatedA,
        repeatedB,
        answer,
        run("run:success", "completed"),
        run("run:failed", "failed"),
      ]),
    ).toEqual(events);
  });

  it("omits routine messages and script messages", () => {
    const routine = message("routine", "Thanks", "user", null);
    const script = decodeEvent({
      ...routine,
      payload: {
        ...routine.payload,
        id: "message_script",
        workflowScript: true,
        text: "do things",
      },
    });
    expect(collectSignificantEvents([routine, script])).toEqual([]);
  });

  it("collects Plotline completion and recovery transitions once", () => {
    const collector = makeSignificantEventCollector();
    const dag = (state: "running" | "done" | "failed", updatedAt: string) =>
      decodeDag({
        id: "dag_test",
        projectId: "project_test",
        title: "Test DAG",
        description: "",
        workspace: null,
        state,
        createdAt: "2026-10-27T12:00:00.000Z",
        updatedAt,
        startedAt: "2026-10-27T12:00:00.000Z",
        finishedAt: state === "done" || state === "failed" ? updatedAt : null,
        tasks: [
          {
            id: "task_test",
            title: "Build dashboard",
            description: "",
            state,
            effort: 2,
            dependsOn: [],
            threadId: "thread_test",
            runId: null,
            legacySessionIds: [],
            agent: null,
            createdAt: "2026-10-27T12:00:00.000Z",
            updatedAt,
            startedAt: "2026-10-27T12:00:00.000Z",
            finishedAt: state === "done" || state === "failed" ? updatedAt : null,
          },
        ],
        events: [],
      });

    expect(collector.observePlotlineDags([dag("running", "2026-10-27T12:00:00.000Z")])).toEqual([]);
    const failure = collector.observePlotlineDags([dag("failed", "2026-10-27T12:00:30.000Z")]);
    expect(failure[0]?.type).toBe("failure");
    const recovery = collector.observePlotlineDags([dag("running", "2026-10-27T12:00:45.000Z")]);
    expect(recovery[0]?.type).toBe("recovered_workflow");
    const completion = collector.observePlotlineDags([dag("done", "2026-10-27T12:01:00.000Z")]);
    expect(completion[0]?.type).toBe("successful_output");
    expect(collector.observePlotlineDags([dag("done", "2026-10-27T12:01:00.000Z")])).toEqual([]);
    expect(collector.snapshot().map((event) => event.threadId)).toEqual([
      "thread_test",
      "thread_test",
      "thread_test",
    ]);
  });

  it("links run signals to a Plotline task only by its exact thread and run IDs", () => {
    const collector = makeSignificantEventCollector();
    const linkedDag = decodeDag({
      id: "dag_linked",
      projectId: "project_test",
      title: "Linked DAG",
      description: "",
      workspace: null,
      state: "running",
      createdAt: "2026-10-27T12:00:00.000Z",
      updatedAt: "2026-10-27T12:00:00.000Z",
      startedAt: "2026-10-27T12:00:00.000Z",
      finishedAt: null,
      tasks: [
        {
          id: "task_linked",
          title: "Build dashboard",
          description: "",
          state: "running",
          effort: 2,
          dependsOn: [],
          threadId: "thread_test",
          runId: "run:linked",
          legacySessionIds: [],
          agent: null,
          createdAt: "2026-10-27T12:00:00.000Z",
          updatedAt: "2026-10-27T12:00:00.000Z",
          startedAt: "2026-10-27T12:00:00.000Z",
          finishedAt: null,
        },
      ],
      events: [],
    });

    collector.observePlotlineDags([linkedDag]);
    const signal = collector.observe(run("run:linked", "completed"));
    expect(signal).toHaveLength(1);
    expect(signal[0]?.sourceRefs).toContain("plotline:dag_linked:task_linked");

    const otherRun = collector.observe(run("run:unlinked", "completed"));
    expect(otherRun[0]?.sourceRefs).not.toContain("plotline:dag_linked:task_linked");
  });

  it("persists completed-run signals and emits a separate signal only after explicit validation", () => {
    const completed = run("run:validated", "completed");
    const collector = makeSignificantEventCollector();
    expect(collector.observe(completed).map((event) => event.type)).toEqual(["successful_output"]);
    const approval = message("approval", "That looks good, thanks", "user", null);
    const validated = collector.observe(approval);
    expect(validated.map((event) => event.type)).toEqual(["validated_success"]);

    // A fresh process restores the bounded signal window and repeated delivery is idempotent.
    const restarted = makeSignificantEventCollector();
    for (const event of collector.snapshot()) restarted.seed(event);
    expect(restarted.observe(completed)).toEqual([]);
    expect(restarted.snapshot().map((event) => event.type)).toEqual([
      "successful_output",
      "validated_success",
    ]);
  });
});
