import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type PlotlineDag,
  type PlotlineDagTask,
  type PlotlineTaskState,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ArrowUpRightIcon, GitBranchIcon, PlusIcon, WorkflowIcon } from "lucide-react";

import { Button } from "./ui/button";
import { SettingsPageContainer } from "./settings/settingsLayout";
import { useProjects, useThreadRefs, useThreadShells } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { usePrimaryEnvironmentId } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";

const TASK_STATES: ReadonlyArray<PlotlineTaskState> = [
  "pending",
  "running",
  "done",
  "failed",
  "skipped",
];

function nowIso() {
  return new Date().toISOString();
}

function makeTask(
  id: string,
  title: string,
  dependsOn: ReadonlyArray<string> = [],
): PlotlineDagTask {
  const now = nowIso();
  return {
    id,
    title,
    description: "",
    state: "pending",
    effort: 2,
    dependsOn: [...dependsOn],
    threadId: null,
    runId: null,
    legacySessionIds: [],
    agent: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
  };
}

function stateClass(state: PlotlineTaskState) {
  switch (state) {
    case "running":
      return "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300";
    case "done":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "failed":
      return "border-destructive/40 bg-destructive/10 text-destructive";
    case "skipped":
      return "border-border bg-muted text-muted-foreground";
    default:
      return "border-border bg-background text-muted-foreground";
  }
}

export function PlotlineDagsPage() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projects = useProjects();
  const environmentId = primaryEnvironmentId ?? projects[0]?.environmentId ?? null;
  const projectOptions =
    environmentId === null ? [] : projects.filter((p) => p.environmentId === environmentId);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const projectId = projectOptions.some((project) => project.id === selectedProjectId)
    ? selectedProjectId
    : projectOptions[0]?.id || "";
  const [selectedDagId, setSelectedDagId] = useState<string | null>(null);
  const [dagTitle, setDagTitle] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [dependencyId, setDependencyId] = useState("");
  const navigate = useNavigate();
  const threadRefs = useThreadRefs();
  const threadShells = useThreadShells();
  const threadTitleById = new Map(threadShells.map((shell) => [shell.threadId, shell.title]));

  const dagsQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.plotlineDagsLive({ environmentId, input: {} }),
  );
  const saveDag = useAtomCommand(serverEnvironment.savePlotlineDag, "save DAG");
  const deleteDag = useAtomCommand(serverEnvironment.deletePlotlineDag, "delete DAG");
  const canWrite = useAtomValue(
    serverEnvironment.savePlotlineDag.permissionAtom(environmentId as EnvironmentId | null),
  );
  const dags = dagsQuery.data?.dags ?? [];
  const selectedDag = dags.find((dag) => dag.id === selectedDagId) ?? dags[0] ?? null;
  const projectNameById = new Map(projectOptions.map((project) => [project.id, project.title]));

  const save = async (dag: PlotlineDag) => {
    if (!environmentId) return;
    await saveDag({ environmentId, input: { dag } });
    setSelectedDagId(dag.id);
  };

  const createDag = async () => {
    const title = dagTitle.trim();
    if (!title || !projectId || !environmentId) return;
    const now = nowIso();
    const id = `dag-${crypto.randomUUID()}`;
    const dag: PlotlineDag = {
      id,
      projectId,
      title,
      description: "",
      workspace: projectOptions.find((project) => project.id === projectId)?.workspaceRoot ?? null,
      state: "waiting",
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      tasks: [],
      events: [],
    };
    await save(dag);
    setDagTitle("");
  };

  const updateDag = (next: PlotlineDag) => void save(next);
  const updateTask = (dag: PlotlineDag, taskId: string, update: Partial<PlotlineDagTask>) => {
    updateDag({
      ...dag,
      tasks: dag.tasks.map((task) =>
        task.id === taskId ? { ...task, ...update, updatedAt: nowIso() } : task,
      ),
    });
  };

  const addTask = () => {
    if (!selectedDag || !taskTitle.trim()) return;
    const id =
      taskTitle
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || `task-${selectedDag.tasks.length + 1}`;
    if (selectedDag.tasks.some((task) => task.id === id)) return;
    updateDag({
      ...selectedDag,
      tasks: [
        ...selectedDag.tasks,
        makeTask(id, taskTitle.trim(), dependencyId ? [dependencyId] : []),
      ],
    });
    setTaskTitle("");
    setDependencyId("");
  };

  const removeSelectedDag = async () => {
    if (!selectedDag || !environmentId) return;
    await deleteDag({ environmentId, input: { id: selectedDag.id, confirm: true } });
    setSelectedDagId(null);
  };

  const importPlotlineFile = async (file: File | undefined) => {
    if (!file || !projectId || !environmentId) return;
    try {
      const parsed = JSON.parse(await file.text()) as { dags?: Array<Record<string, unknown>> };
      const existingIds = new Set(dags.map((dag) => dag.id));
      for (const source of parsed.dags ?? []) {
        if (typeof source.id !== "string" || typeof source.title !== "string") continue;
        const now = nowIso();
        const importedId = existingIds.has(source.id) ? `import-${crypto.randomUUID()}` : source.id;
        const tasks = Array.isArray(source.tasks)
          ? (source.tasks as Array<Record<string, unknown>>)
          : [];
        const events = Array.isArray(source.events)
          ? (source.events as Array<Record<string, unknown>>)
          : [];
        const imported: PlotlineDag = {
          id: importedId,
          projectId,
          title: source.title,
          description: typeof source.description === "string" ? source.description : "",
          workspace: typeof source.workspace === "string" ? source.workspace : null,
          state: "waiting",
          createdAt: typeof source.createdAt === "string" ? source.createdAt : now,
          updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : now,
          startedAt: typeof source.startedAt === "string" ? source.startedAt : null,
          finishedAt: typeof source.finishedAt === "string" ? source.finishedAt : null,
          tasks: tasks.flatMap((task) => {
            if (typeof task.id !== "string" || typeof task.title !== "string") return [];
            const createdAt = typeof task.createdAt === "string" ? task.createdAt : now;
            return [
              {
                id: task.id,
                title: task.title,
                description: typeof task.description === "string" ? task.description : "",
                state: TASK_STATES.includes(task.state as PlotlineTaskState)
                  ? (task.state as PlotlineTaskState)
                  : "pending",
                effort:
                  Number.isInteger(task.effort) &&
                  Number(task.effort) >= 1 &&
                  Number(task.effort) <= 5
                    ? Number(task.effort)
                    : 2,
                dependsOn: Array.isArray(task.dependsOn)
                  ? task.dependsOn.filter((id): id is string => typeof id === "string")
                  : [],
                threadId: null,
                runId: typeof task.runId === "string" ? task.runId : null,
                legacySessionIds: Array.isArray(task.sessionIDs)
                  ? task.sessionIDs.filter((id): id is string => typeof id === "string")
                  : [],
                agent: typeof task.agent === "string" ? task.agent : null,
                createdAt,
                updatedAt: typeof task.updatedAt === "string" ? task.updatedAt : createdAt,
                startedAt: typeof task.startedAt === "string" ? task.startedAt : null,
                finishedAt: typeof task.finishedAt === "string" ? task.finishedAt : null,
              },
            ];
          }),
          events: events.flatMap((event, index) => {
            if (typeof event.message !== "string") return [];
            const levels = ["info", "live", "ok", "error"] as const;
            return [
              {
                id: typeof event.id === "string" ? event.id : `import-event-${index}`,
                at: typeof event.at === "string" ? event.at : now,
                level: levels.includes(event.level as (typeof levels)[number])
                  ? (event.level as (typeof levels)[number])
                  : "info",
                message: event.message,
                taskId: typeof event.taskID === "string" ? event.taskID : null,
              },
            ];
          }),
        };
        const states = imported.tasks.map((task) => task.state);
        const importedState = states.includes("failed")
          ? "failed"
          : states.includes("running")
            ? "running"
            : states.length > 0 && states.every((state) => state === "done" || state === "skipped")
              ? "done"
              : "waiting";
        const readyToSave = { ...imported, state: importedState };
        await save(readyToSave);
        existingIds.add(importedId);
      }
    } catch {
      window.alert("The Plotline state file could not be imported.");
    }
  };

  if (environmentId === null) {
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">Connect a T3 environment to view DAGs.</p>
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="mb-2 flex items-center gap-2 text-muted-foreground">
              <WorkflowIcon className="size-4" />{" "}
              <span className="text-xs font-medium uppercase tracking-wide">Plotline</span>
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">DAGs</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Plan, track, and open the T3 threads attached to each task.
            </p>
          </div>
          <div className="flex gap-2">
            <select
              aria-label="Project"
              value={projectId}
              onChange={(event) => setSelectedProjectId(event.target.value)}
              className="h-9 max-w-60 rounded-md border border-input bg-background px-3 text-sm"
            >
              {projectOptions.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.title}
                </option>
              ))}
            </select>
            <input
              aria-label="DAG title"
              value={dagTitle}
              onChange={(event) => setDagTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void createDag();
              }}
              placeholder="New DAG title"
              className="h-9 w-48 rounded-md border border-input bg-background px-3 text-sm"
            />
            <Button
              disabled={!canWrite || !projectId || !dagTitle.trim()}
              onClick={() => void createDag()}
            >
              <PlusIcon className="size-4" /> Create
            </Button>
            <label className="inline-flex h-9 cursor-pointer items-center rounded-md border border-input px-3 text-sm hover:bg-muted">
              Import Plotline
              <input
                type="file"
                accept="application/json,.json"
                className="sr-only"
                disabled={!canWrite || !projectId}
                onChange={(event) => {
                  void importPlotlineFile(event.currentTarget.files?.[0]);
                  event.currentTarget.value = "";
                }}
              />
            </label>
          </div>
        </header>

        {dagsQuery.error ? (
          <p role="alert" className="text-sm text-destructive">
            {dagsQuery.error}
          </p>
        ) : null}
        <div className="grid min-h-96 gap-5 md:grid-cols-[15rem_minmax(0,1fr)]">
          <aside className="flex flex-col gap-2 border-r border-border pr-3">
            {dags.length === 0 ? (
              <p className="px-2 py-3 text-sm text-muted-foreground">No DAGs yet.</p>
            ) : (
              dags.map((dag) => (
                <button
                  key={dag.id}
                  onClick={() => setSelectedDagId(dag.id)}
                  className={`rounded-md px-3 py-2 text-left ${selectedDag?.id === dag.id ? "bg-accent text-accent-foreground" : "hover:bg-muted"}`}
                >
                  <span className="block truncate text-sm font-medium">{dag.title}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {dag.state} · {dag.tasks.length} tasks
                  </span>
                </button>
              ))
            )}
          </aside>

          {!selectedDag ? (
            <div className="flex min-h-72 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border text-center text-muted-foreground">
              <GitBranchIcon className="size-5" />
              <p className="text-sm">Create a DAG to start planning tasks.</p>
            </div>
          ) : (
            <section className="min-w-0 space-y-5">
              <div className="flex items-start justify-between gap-3 border-b border-border pb-4">
                <div className="min-w-0">
                  <h2 className="truncate text-lg font-semibold">{selectedDag.title}</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {projectNameById.get(selectedDag.projectId) ?? selectedDag.projectId} ·{" "}
                    {selectedDag.state}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!canWrite}
                  onClick={() => void removeSelectedDag()}
                >
                  Delete
                </Button>
              </div>

              <div className="space-y-3">
                {selectedDag.tasks.map((task) => {
                  const threadRef = threadRefs.find(
                    (ref) => ref.environmentId === environmentId && ref.threadId === task.threadId,
                  );
                  return (
                    <article
                      key={task.id}
                      className="relative rounded-lg border border-border bg-card p-4"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate font-medium">{task.title}</span>
                            <span
                              className={`rounded-full border px-2 py-0.5 text-xs ${stateClass(task.state)}`}
                            >
                              {task.state}
                            </span>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            <code>{task.id}</code>
                          </p>
                        </div>
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                          Effort
                          <select
                            aria-label={`Effort for ${task.title}`}
                            value={task.effort}
                            disabled={!canWrite}
                            onChange={(event) =>
                              updateTask(selectedDag, task.id, {
                                effort: Number(event.target.value),
                              })
                            }
                            className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
                          >
                            {[1, 2, 3, 4, 5].map((effort) => (
                              <option key={effort} value={effort}>
                                {"●".repeat(effort)}
                                {"○".repeat(5 - effort)}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <label className="text-xs text-muted-foreground">Dependencies</label>
                        {task.dependsOn.map((dependency) => (
                          <span
                            key={dependency}
                            className="rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground"
                          >
                            {selectedDag.tasks.find((candidate) => candidate.id === dependency)
                              ?.title ?? dependency}
                          </span>
                        ))}
                        <select
                          aria-label={`Dependencies for ${task.title}`}
                          multiple
                          value={task.dependsOn}
                          disabled={!canWrite}
                          onChange={(event) =>
                            updateTask(selectedDag, task.id, {
                              dependsOn: Array.from(
                                event.currentTarget.selectedOptions,
                                (option) => option.value,
                              ),
                            })
                          }
                          className="h-16 min-w-36 rounded-md border border-input bg-background px-2 text-sm"
                        >
                          {selectedDag.tasks
                            .filter((candidate) => candidate.id !== task.id)
                            .map((candidate) => (
                              <option key={candidate.id} value={candidate.id}>
                                {candidate.title}
                              </option>
                            ))}
                        </select>
                        <label className="text-xs text-muted-foreground">State</label>
                        <select
                          aria-label={`State for ${task.title}`}
                          value={task.state}
                          disabled={!canWrite}
                          onChange={(event) =>
                            updateTask(selectedDag, task.id, {
                              state: event.target.value as PlotlineTaskState,
                            })
                          }
                          className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                        >
                          {TASK_STATES.map((state) => (
                            <option key={state} value={state}>
                              {state}
                            </option>
                          ))}
                        </select>
                        <select
                          aria-label={`T3 thread for ${task.title}`}
                          value={task.threadId ?? ""}
                          disabled={!canWrite}
                          onChange={(event) =>
                            updateTask(selectedDag, task.id, {
                              threadId: (event.target.value || null) as PlotlineDagTask["threadId"],
                            })
                          }
                          className="h-8 min-w-48 max-w-full rounded-md border border-input bg-background px-2 text-sm"
                        >
                          <option value="">No T3 thread linked</option>
                          {threadRefs
                            .filter((ref) => ref.environmentId === environmentId)
                            .map((ref) => (
                              <option key={ref.threadId} value={ref.threadId}>
                                {threadTitleById.get(ref.threadId) ?? ref.threadId}
                              </option>
                            ))}
                        </select>
                        {threadRef ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              void navigate({
                                to: "/$environmentId/$threadId",
                                params: {
                                  environmentId: threadRef.environmentId,
                                  threadId: threadRef.threadId,
                                },
                              })
                            }
                          >
                            Open thread <ArrowUpRightIcon className="size-3.5" />
                          </Button>
                        ) : null}
                        <input
                          aria-label={`Agent for ${task.title}`}
                          defaultValue={task.agent ?? ""}
                          disabled={!canWrite}
                          onBlur={(event) =>
                            updateTask(selectedDag, task.id, { agent: event.target.value || null })
                          }
                          placeholder="Agent"
                          className="h-8 w-32 rounded-md border border-input bg-background px-2 text-sm"
                        />
                        <input
                          aria-label={`Run for ${task.title}`}
                          defaultValue={task.runId ?? ""}
                          disabled={!canWrite}
                          onBlur={(event) =>
                            updateTask(selectedDag, task.id, { runId: event.target.value || null })
                          }
                          placeholder="T3 run ID"
                          className="h-8 w-36 rounded-md border border-input bg-background px-2 text-sm"
                        />
                      </div>
                    </article>
                  );
                })}
              </div>

              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border p-3">
                <input
                  aria-label="Task title"
                  value={taskTitle}
                  onChange={(event) => setTaskTitle(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") addTask();
                  }}
                  placeholder="Add task"
                  className="h-9 min-w-44 flex-1 rounded-md border border-input bg-background px-3 text-sm"
                />
                <select
                  aria-label="Task dependency"
                  value={dependencyId}
                  onChange={(event) => setDependencyId(event.target.value)}
                  className="h-9 max-w-52 rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">No dependency</option>
                  {selectedDag.tasks.map((task) => (
                    <option key={task.id} value={task.id}>
                      {task.title}
                    </option>
                  ))}
                </select>
                <Button size="sm" disabled={!canWrite || !taskTitle.trim()} onClick={addTask}>
                  <PlusIcon className="size-4" /> Add task
                </Button>
              </div>

              <div className="space-y-2 border-t border-border pt-4">
                <h3 className="text-sm font-medium">Activity</h3>
                {selectedDag.events.slice(0, 12).map((event) => (
                  <p key={event.id} className="text-xs text-muted-foreground">
                    <time dateTime={event.at}>{new Date(event.at).toLocaleString()}</time> ·{" "}
                    {event.message}
                  </p>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </SettingsPageContainer>
  );
}
