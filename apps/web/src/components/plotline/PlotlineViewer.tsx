import type { PlotlineDag, PlotlineDagTask } from "@t3tools/contracts";
// oxlint-disable shadcn/no-unknown-classes -- Plotline's original visual system uses scoped component CSS.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Minus, Pause, Play, Plus, RotateCcw } from "lucide-react";

import { observeResize } from "../../lib/observeResize";
import "./plotline.css";

const NODE_WIDTH = 196;
const NODE_HEIGHT = 100;
const GAP_X = 44;
const GAP_Y = 34;
const PADDING = 36;
const MIN_MAP_WIDTH = 880;
const MIN_MAP_HEIGHT = 500;

const RUN_LABELS: Record<PlotlineDag["state"], string> = {
  waiting: "EN ATTENTE",
  running: "EN COURS",
  done: "TERMINÉ",
  failed: "ÉCHEC",
};
const TASK_LABELS: Record<PlotlineDagTask["state"], string> = {
  pending: "EN ATTENTE",
  running: "EN COURS",
  done: "TERMINÉ",
  failed: "ÉCHEC",
  skipped: "IGNORÉ",
};
const TASK_CLASS: Record<PlotlineDagTask["state"], string> = {
  pending: "pending",
  running: "running",
  done: "done",
  failed: "error",
  skipped: "skipped",
};

interface Point {
  x: number;
  y: number;
}

function graphLayout(tasks: readonly PlotlineDagTask[]) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map(tasks.map((task) => [task.id, [] as string[]]));
  const indegree = new Map<string, number>();
  for (const task of tasks) {
    const dependencies = task.dependsOn.filter((id) => byId.has(id));
    indegree.set(task.id, dependencies.length);
    for (const id of dependencies) dependents.get(id)?.push(task.id);
  }

  const levels = new Map(tasks.map((task) => [task.id, 0]));
  const queue = tasks.filter((task) => indegree.get(task.id) === 0).map((task) => task.id);
  const processed = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    processed.add(id);
    for (const dependent of dependents.get(id) ?? []) {
      levels.set(dependent, Math.max(levels.get(dependent) ?? 0, (levels.get(id) ?? 0) + 1));
      const nextIndegree = (indegree.get(dependent) ?? 1) - 1;
      indegree.set(dependent, nextIndegree);
      if (nextIndegree === 0) queue.push(dependent);
    }
  }
  // Preserve visibility of malformed legacy cycles rather than dropping nodes.
  for (const task of tasks) {
    if (!processed.has(task.id)) {
      levels.set(task.id, Math.max(0, ...task.dependsOn.map((id) => levels.get(id) ?? 0)) + 1);
    }
  }

  const groups = new Map<number, PlotlineDagTask[]>();
  for (const task of tasks) {
    const level = levels.get(task.id) ?? 0;
    const group = groups.get(level) ?? [];
    group.push(task);
    groups.set(level, group);
  }
  const maxLevel = Math.max(0, ...groups.keys());
  const maxColumns = Math.max(1, ...Array.from(groups.values(), (group) => group.length));
  const positions = new Map<string, Point>();
  for (const [level, group] of groups) {
    const width = group.length * NODE_WIDTH + (group.length - 1) * GAP_X;
    const fullWidth = maxColumns * NODE_WIDTH + (maxColumns - 1) * GAP_X;
    const start = PADDING + (fullWidth - width) / 2;
    group.forEach((task, index) => {
      positions.set(task.id, {
        x: start + index * (NODE_WIDTH + GAP_X),
        y: PADDING + level * (NODE_HEIGHT + GAP_Y),
      });
    });
  }
  return {
    positions,
    contentWidth: PADDING * 2 + maxColumns * NODE_WIDTH + (maxColumns - 1) * GAP_X,
    contentHeight: PADDING * 2 + (maxLevel + 1) * NODE_HEIGHT + maxLevel * GAP_Y,
  };
}

function durationText(dag: PlotlineDag, now: number) {
  const start = Date.parse(dag.startedAt ?? dag.createdAt);
  if (!Number.isFinite(start)) return "indisponible";
  const finish = dag.finishedAt ? Date.parse(dag.finishedAt) : now;
  const seconds = Math.max(
    0,
    Math.floor(((Number.isFinite(finish) ? finish : now) - start) / 1000),
  );
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function timeText(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString("fr-FR", { hour12: false });
}

function dateText(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "indisponible"
    : date.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "medium" });
}

/** Plotline remains read-only: guard labels derive from persisted DAG evidence. */
function loopGuardStatus(dag: PlotlineDag, taskId: string): string {
  const latest = dag.events
    .filter((event) => event.taskId === taskId && event.message.startsWith("Loop Guard: "))
    .at(-1);
  const state = latest?.message.split(" ")[2];
  return state && ["warning", "recovery", "escalated", "resolved"].includes(state)
    ? state
    : "normal";
}

function EventText({ dag, event }: { dag: PlotlineDag; event: PlotlineDag["events"][number] }) {
  const title = dag.tasks.find((task) => task.id === event.taskId)?.title;
  const label = title ?? (event.message.startsWith("Run ") ? null : "Run");
  return (
    <span>
      {label ? <strong>{label}</strong> : null}
      {label ? " · " : ""}
      {event.message}
    </span>
  );
}

function EffortDots({ effort }: { effort: number }) {
  const bounded = Math.min(5, Math.max(1, Math.round(effort)));
  return (
    <span className="plotline-effort-dots" aria-label={`Effort ${bounded} sur 5`}>
      {Array.from({ length: 5 }, (_, index) => (
        <i className={index < bounded ? "on" : undefined} key={index} />
      ))}
    </span>
  );
}

export interface PlotlineViewerProps {
  dag: PlotlineDag;
  onOpenThread?: (threadId: string) => void;
  maximized?: boolean;
}

/** Read-only Plotline observer. Writes remain exclusively on the agent/orchestrator side. */
export function PlotlineViewer({ dag, onOpenThread, maximized = false }: PlotlineViewerProps) {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [paused, setPaused] = useState(false);
  const [frozenDag, setFrozenDag] = useState(dag);
  const [now, setNow] = useState(() => Date.now());
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewportSize, setViewportSize] = useState({
    width: MIN_MAP_WIDTH,
    height: MIN_MAP_HEIGHT,
  });
  const viewDag = paused && frozenDag.id === dag.id ? frozenDag : dag;
  const { positions, contentWidth, contentHeight } = graphLayout(viewDag.tasks);

  // oxlint-disable-next-line t3code/react-effect-budget -- The clock is an external timer for elapsed duration while the viewer is live.
  useEffect(() => {
    if (paused) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [paused]);

  // oxlint-disable-next-line t3code/react-effect-budget -- Observe the panel viewport so graph sizing follows responsive resizes.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    return observeResize(viewport, (entries) => {
      const bounds = entries[0]?.contentRect;
      if (!bounds) return;
      setViewportSize({
        width: bounds.width || MIN_MAP_WIDTH,
        height: bounds.height || MIN_MAP_HEIGHT,
      });
    });
  }, []);

  const selectedTask = viewDag.tasks.find((task) => task.id === selectedTaskId) ?? null;
  const runningTasks = viewDag.tasks.filter((task) => task.state === "running");
  const activeAgents = new Set(runningTasks.flatMap((task) => (task.agent ? [task.agent] : [])));
  const activeAgentSummary =
    runningTasks.length === 0
      ? "0"
      : runningTasks.some((task) => !task.agent)
        ? "indisponible"
        : `${activeAgents.size} actif${activeAgents.size === 1 ? "" : "s"}`;
  const completedCount = viewDag.tasks.filter(
    (task) => task.state === "done" || task.state === "skipped",
  ).length;
  const percentage = viewDag.tasks.length
    ? Math.round((completedCount / viewDag.tasks.length) * 100)
    : 0;
  const mapWidth = Math.max(contentWidth, viewportSize.width);
  const mapHeight = Math.max(contentHeight, viewportSize.height, MIN_MAP_HEIGHT);
  const shiftX = Math.max(0, (mapWidth - contentWidth) / 2);
  const edgeCount = viewDag.tasks.reduce((total, task) => total + task.dependsOn.length, 0);

  return (
    <div className={`plotline-viewer${maximized ? " plotline-viewer-maximized" : ""}`}>
      <div className="plotline-topline">
        <div className="plotline-crumb">
          PLOTLINE&nbsp; / &nbsp;<strong>{viewDag.title.toUpperCase()}</strong>
        </div>
        <div className="plotline-top-right">
          <div className="plotline-live">
            <i className={paused ? "paused" : ""} />
            <span>{paused ? "FLUX EN PAUSE" : "LIVE · ACTUALISATION"}</span>
          </div>
          <button
            className="plotline-pause"
            type="button"
            aria-label={paused ? "Reprendre l’actualisation" : "Mettre en pause l’actualisation"}
            onClick={() => {
              if (!paused) setFrozenDag(dag);
              setPaused(!paused);
            }}
          >
            {paused ? <Play size={13} /> : <Pause size={13} />}
          </button>
        </div>
      </div>
      <header className="plotline-page-head">
        <div>
          <div className="plotline-kicker">
            OBSERVABILITÉ&nbsp; / &nbsp;{RUN_LABELS[viewDag.state] ?? "RUN"}
          </div>
          <h1>{viewDag.title}</h1>
          <div className="plotline-subhead">
            {viewDag.description || "Aucune description fournie."}
          </div>
        </div>
        <div className="plotline-read-only">◉ &nbsp; Lecture seule</div>
      </header>

      <section className="plotline-runbar" aria-label="Résumé de l’exécution">
        <div className="plotline-run-meta">
          <div className="plotline-meta-label">Run ID</div>
          <div className="plotline-meta-value">{viewDag.id}</div>
        </div>
        <div className="plotline-run-meta">
          <div className="plotline-meta-label">État · durée</div>
          <div className="plotline-meta-value">
            {RUN_LABELS[viewDag.state]} · {durationText(viewDag, now)}
          </div>
        </div>
        <div className="plotline-run-meta">
          <div className="plotline-meta-label">Agents actifs</div>
          <div className="plotline-meta-value">{activeAgentSummary}</div>
        </div>
        <div className="plotline-run-meta">
          <div className="plotline-meta-label">Tâches terminées</div>
          <div className="plotline-progress-meta">
            <div className="plotline-progress-track">
              <span style={{ width: `${percentage}%` }} />
            </div>
            <div className="plotline-progress-text">
              {viewDag.tasks.length ? `${completedCount}/${viewDag.tasks.length}` : "indisponible"}
            </div>
          </div>
        </div>
        <div className="plotline-run-meta plotline-usage-total">
          <div className="plotline-meta-label">Tokens · coût</div>
          <div className="plotline-meta-value">indisponible</div>
        </div>
      </section>

      <section className="plotline-canvas-shell" aria-label="Graphe de dépendances">
        <div className="plotline-canvas-top">
          <div className="plotline-canvas-caption">
            Dépendances{" "}
            <span>
              {String(viewDag.tasks.length).padStart(2, "0")} NŒUD
              {viewDag.tasks.length === 1 ? "" : "S"} / {String(edgeCount).padStart(2, "0")} ARÊTE
              {edgeCount === 1 ? "" : "S"}
            </span>
          </div>
          <div className="plotline-tools">
            <button
              className="plotline-tool"
              type="button"
              aria-label="Réduire"
              onClick={() => setZoom((value) => Math.max(0.5, Number((value - 0.1).toFixed(2))))}
            >
              <Minus size={12} />
            </button>
            <button
              className="plotline-tool plotline-zoom-reset"
              type="button"
              aria-label="Réinitialiser le zoom"
              onClick={() => setZoom(1)}
            >
              <RotateCcw size={11} /> {Math.round(zoom * 100)}%
            </button>
            <button
              className="plotline-tool"
              type="button"
              aria-label="Agrandir"
              onClick={() => setZoom((value) => Math.min(1.8, Number((value + 0.1).toFixed(2))))}
            >
              <Plus size={12} />
            </button>
          </div>
        </div>
        <div className="plotline-map-viewport" ref={viewportRef}>
          {viewDag.tasks.length === 0 ? (
            <div className="plotline-empty-state">
              <div>
                <div className="plotline-empty-mark">PL</div>
                <h2>Aucune tâche publiée</h2>
                <p>Ce DAG existe mais ne contient encore aucune tâche.</p>
              </div>
            </div>
          ) : (
            <div className="plotline-map" style={{ width: mapWidth, height: mapHeight, zoom }}>
              <svg
                className="plotline-wires"
                viewBox={`0 0 ${mapWidth} ${mapHeight}`}
                aria-hidden="true"
              >
                {viewDag.tasks.flatMap((task) =>
                  task.dependsOn.map((dependencyId) => {
                    const from = positions.get(dependencyId);
                    const to = positions.get(task.id);
                    const parent = viewDag.tasks.find((candidate) => candidate.id === dependencyId);
                    if (!from || !to) return null;
                    const x1 = from.x + shiftX + NODE_WIDTH / 2;
                    const y1 = from.y + NODE_HEIGHT;
                    const x2 = to.x + shiftX + NODE_WIDTH / 2;
                    const y2 = to.y;
                    const statusClass =
                      task.state === "running"
                        ? "live"
                        : task.state === "failed"
                          ? "failed"
                          : parent?.state === "done"
                            ? "done"
                            : "";
                    return (
                      <path
                        key={`${dependencyId}-${task.id}`}
                        className={`plotline-wire ${statusClass}`}
                        d={`M${x1} ${y1} C${x1} ${y1 + 28} ${x2} ${y2 - 28} ${x2} ${y2}`}
                      />
                    );
                  }),
                )}
              </svg>
              {viewDag.tasks.map((task) => {
                const position = positions.get(task.id);
                if (!position) return null;
                const guard = loopGuardStatus(viewDag, task.id);
                return (
                  <button
                    key={task.id}
                    type="button"
                    className={`plotline-node ${TASK_CLASS[task.state]}${selectedTaskId === task.id ? " selected" : ""}`}
                    style={{ left: position.x + shiftX, top: position.y }}
                    aria-pressed={selectedTaskId === task.id}
                    onClick={() => setSelectedTaskId(task.id)}
                  >
                    <div className="plotline-node-head">
                      <span className="plotline-node-name">{task.title}</span>
                      <span className="plotline-node-state">{TASK_LABELS[task.state]}</span>
                    </div>
                    <div className="plotline-node-desc">{task.description || "indisponible"}</div>
                    <div className="plotline-node-effort">
                      <span className="plotline-effort-label">EFFORT</span>
                      <EffortDots effort={task.effort} />
                      <span className="plotline-effort-level">{task.effort}/5</span>
                    </div>
                    <div className="plotline-node-foot">
                      <span>
                        {task.agent ? (
                          `agent · ${task.agent}`
                        ) : (
                          <em className="plotline-unavailable">agent indisponible</em>
                        )}
                      </span>
                      <span className="plotline-unavailable">
                        {guard === "normal" ? "métriques indisponibles" : `Loop Guard · ${guard}`}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <div className="plotline-map-key" aria-hidden="true">
          <span className="plotline-key">
            <i className="kdone" />
            Terminé
          </span>
          <span className="plotline-key">
            <i className="krun" />
            En cours
          </span>
          <span className="plotline-key">
            <i className="kwait" />
            En attente
          </span>
          <span className="plotline-key">
            <i className="kerror" />
            Échec
          </span>
          <span className="plotline-key">
            <i className="kskip" />
            Ignoré
          </span>
        </div>
      </section>

      <section className="plotline-under">
        <div>
          <div className="plotline-section-head">
            <div className="plotline-section-title">Journal d’activité</div>
            <div className="plotline-section-side">ÉVÉNEMENTS RÉCENTS</div>
          </div>
          <div className="plotline-event-list">
            {viewDag.events.length === 0 ? (
              <div className="plotline-event-empty">Aucun événement publié.</div>
            ) : (
              viewDag.events.slice(0, 4).map((event) => (
                <div className="plotline-event" key={event.id}>
                  <span className="plotline-event-time">{timeText(event.at)}</span>
                  <i className={`plotline-event-dot ${event.level}`} />
                  <EventText dag={viewDag} event={event} />
                </div>
              ))
            )}
          </div>
        </div>
        <div>
          <div className="plotline-section-head">
            <div className="plotline-section-title">Inspection</div>
            <div className="plotline-section-side">
              {selectedTask ? TASK_LABELS[selectedTask.state] : "SÉLECTIONNER UN NŒUD"}
            </div>
          </div>
          <div className="plotline-inspect">
            {!selectedTask ? (
              <div className="plotline-inspect-empty">
                Sélectionne un nœud pour afficher ses détails.
              </div>
            ) : (
              <>
                <div className="plotline-inspect-name">{selectedTask.title}</div>
                <div className="plotline-inspect-desc">
                  {selectedTask.description || "Aucune description fournie."}
                </div>
                <div className="plotline-inspect-grid">
                  <InspectCell label="État">{TASK_LABELS[selectedTask.state]}</InspectCell>
                   <InspectCell label="Loop Guard">{loopGuardStatus(viewDag, selectedTask.id)}</InspectCell>
                  <InspectCell label="Effort estimé">{selectedTask.effort} / 5</InspectCell>
                  <InspectCell label="Agent / modèle">
                    {selectedTask.agent || <em>non renseigné</em>}
                  </InspectCell>
                  <InspectCell label="Dépendances">
                    {selectedTask.dependsOn.length
                      ? selectedTask.dependsOn
                          .map((id) => dag.tasks.find((task) => task.id === id)?.title ?? id)
                          .join(" · ")
                      : "Aucune"}
                  </InspectCell>
                  <InspectCell label="Tokens">indisponible</InspectCell>
                  <InspectCell label="Coût">indisponible</InspectCell>
                  <InspectCell label="Run lié">
                    {selectedTask.runId || <em>indisponible</em>}
                  </InspectCell>
                  <InspectCell label="Dernière mise à jour">
                    {dateText(selectedTask.updatedAt)}
                  </InspectCell>
                </div>
                <div className="plotline-sessions">
                  <div className="plotline-sessions-title">Conversation T3 liée</div>
                  {selectedTask.threadId && onOpenThread ? (
                    <button
                      className="plotline-thread-link"
                      type="button"
                      onClick={() => onOpenThread(selectedTask.threadId!)}
                    >
                      <span>{selectedTask.threadId}</span>
                      <ArrowUpRight size={12} />
                    </button>
                  ) : (
                    <div className="plotline-inspect-empty">Aucune conversation liée.</div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </section>
      <div className="plotline-footnote">
        Effort estimé · métriques indisponibles · lecture seule
        {paused ? " · actualisation suspendue" : ""}
      </div>
    </div>
  );
}

function InspectCell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="plotline-inspect-cell">
      <div className="plotline-inspect-label">{label}</div>
      <div className="plotline-inspect-val">{children}</div>
    </div>
  );
}
