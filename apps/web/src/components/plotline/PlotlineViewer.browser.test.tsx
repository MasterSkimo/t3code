import { ThreadId, type PlotlineDag } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { PlotlineViewer } from "./PlotlineViewer";

const baseDag: PlotlineDag = {
  id: "release-run",
  projectId: "project-1",
  title: "Release build",
  description: "Compile and verify the release",
  workspace: "/work/app",
  state: "running",
  createdAt: "2026-10-28T09:00:00.000Z",
  updatedAt: "2026-10-28T09:01:00.000Z",
  startedAt: "2026-10-28T09:00:00.000Z",
  finishedAt: null,
  tasks: [
    {
      id: "compile",
      title: "Compile",
      description: "Build the packages",
      state: "done",
      effort: 2,
      dependsOn: [],
      threadId: null,
      runId: null,
      legacySessionIds: [],
      agent: "builder",
      createdAt: "2026-10-28T09:00:00.000Z",
      updatedAt: "2026-10-28T09:00:30.000Z",
      startedAt: "2026-10-28T09:00:00.000Z",
      finishedAt: "2026-10-28T09:00:30.000Z",
    },
    {
      id: "verify",
      title: "Verify",
      description: "Run integration tests",
      state: "running",
      effort: 4,
      dependsOn: ["compile"],
      threadId: ThreadId.make("thread-verify"),
      runId: "run-verify",
      legacySessionIds: [],
      agent: "tester",
      createdAt: "2026-10-28T09:00:30.000Z",
      updatedAt: "2026-10-28T09:01:00.000Z",
      startedAt: "2026-10-28T09:00:30.000Z",
      finishedAt: null,
    },
  ],
  events: [
    {
      id: "event-1",
      at: "2026-10-28T09:00:30.000Z",
      level: "ok",
      message: "Compilation completed",
      taskId: "compile",
    },
  ],
};

const parallelDag: PlotlineDag = {
  ...baseDag,
  id: "parallel-run",
  title: "Parallel release build",
  tasks: [
    baseDag.tasks[0]!,
    {
      ...baseDag.tasks[0]!,
      id: "lint",
      title: "Lint",
      description: "Check source formatting",
      state: "failed",
      effort: 1,
      finishedAt: "2026-10-28T09:00:20.000Z",
    },
    baseDag.tasks[1]!,
    {
      ...baseDag.tasks[1]!,
      id: "bundle",
      title: "Bundle",
      description: "Create the distribution bundle",
      state: "pending",
      effort: 3,
      dependsOn: ["lint"],
      threadId: null,
      runId: null,
      agent: "builder",
      startedAt: null,
      finishedAt: null,
    },
    {
      ...baseDag.tasks[1]!,
      id: "release",
      title: "Release",
      description: "Publish the build artifacts",
      state: "pending",
      effort: 5,
      dependsOn: ["verify", "bundle"],
      threadId: null,
      runId: null,
      agent: null,
      startedAt: null,
      finishedAt: null,
    },
  ],
};

describe("PlotlineViewer", () => {
  it("renders the dependency graph and stays read-only while allowing observation controls", async () => {
    const onOpenThread = vi.fn();
    await using screen = await render(
      <PlotlineViewer dag={baseDag} onOpenThread={onOpenThread} />,
      {
        router: false,
      },
    );

    expect(screen.getByRole("button", { name: /Compile/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Verify/ })).toBeVisible();
    expect(screen.container.querySelectorAll(".plotline-wire")).toHaveLength(1);
    expect(screen.container.querySelectorAll(".plotline-effort-dots i")).toHaveLength(10);
    expect(screen.getByText("Journal d’activité")).toBeVisible();
    expect(screen.getByText("Inspection")).toBeVisible();
    expect(screen.getByText("indisponible")).toBeVisible();
    expect(
      screen.container.querySelectorAll("input, textarea, select, [role=textbox], [role=combobox]"),
    ).toHaveLength(0);
    expect(
      screen.container.querySelectorAll(
        'button[aria-label*="supprimer"], button[aria-label*="modifier"], button[aria-label*="créer"]',
      ),
    ).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: /Verify/ }));
    expect(screen.container.querySelector(".plotline-canvas-caption")?.textContent).toContain(
      "Dépendances",
    );
    await userEvent.click(screen.getByRole("button", { name: "thread-verify" }));
    expect(onOpenThread).toHaveBeenCalledWith("thread-verify");
    await userEvent.click(screen.getByRole("button", { name: "Agrandir" }));
    expect(screen.getByRole("button", { name: "Réinitialiser le zoom" })).toHaveTextContent("110%");
  });

  it("holds the displayed snapshot while live updates are paused", async () => {
    await using screen = await render(<PlotlineViewer key={baseDag.id} dag={baseDag} />, {
      router: false,
    });
    await userEvent.click(screen.getByRole("button", { name: "Mettre en pause l’actualisation" }));
    const updatedDag: PlotlineDag = {
      ...baseDag,
      state: "done",
      updatedAt: "2026-10-28T09:02:00.000Z",
      tasks: baseDag.tasks.map((task) => ({ ...task, state: "done" as const })),
    };
    await screen.rerender(<PlotlineViewer key={baseDag.id} dag={updatedDag} />);

    expect(screen.getByText("FLUX EN PAUSE")).toBeVisible();
    expect(
      screen.container.querySelector(".plotline-node.running .plotline-node-name")?.textContent,
    ).toBe("Verify");
    expect(
      screen.container.querySelector(".plotline-node.done .plotline-node-name")?.textContent,
    ).toBe("Compile");

    const nextRun: PlotlineDag = {
      ...baseDag,
      id: "second-run",
      title: "Second run",
      state: "running",
    };
    await screen.rerender(<PlotlineViewer key={nextRun.id} dag={nextRun} />);
    expect(screen.getByRole("heading", { name: "Second run" })).toBeVisible();
    expect(screen.getByText("FLUX EN PAUSE")).not.toBeInTheDocument();
    const updatedNextRun: PlotlineDag = {
      ...nextRun,
      state: "done",
      tasks: nextRun.tasks.map((task) => ({ ...task, state: "done" as const })),
    };
    await screen.rerender(<PlotlineViewer key={updatedNextRun.id} dag={updatedNextRun} />);
    expect(
      screen.container.querySelector(".plotline-node.done .plotline-node-name")?.textContent,
    ).toBe("Compile");
  });

  it("keeps parallel tasks side by side in a narrow panel and exposes the selected task details", async () => {
    const container = document.createElement("div");
    container.style.width = "700px";
    container.style.height = "700px";
    await using screen = await render(<PlotlineViewer dag={parallelDag} />, {
      container,
      router: false,
    });

    const node = (title: string) =>
      [...screen.container.querySelectorAll<HTMLButtonElement>(".plotline-node")].find(
        (candidate) => candidate.querySelector(".plotline-node-name")?.textContent === title,
      )!;
    const compile = node("Compile");
    const lint = node("Lint");
    const verify = node("Verify");
    const bundle = node("Bundle");
    const release = node("Release");
    expect(compile.style.top).toBe(lint.style.top);
    expect(compile.style.left).not.toBe(lint.style.left);
    expect(verify.style.top).toBe(bundle.style.top);
    expect(verify.style.left).not.toBe(bundle.style.left);
    expect(Number.parseFloat(release.style.top)).toBeGreaterThan(
      Number.parseFloat(verify.style.top),
    );
    expect(screen.container.querySelectorAll(".plotline-wire")).toHaveLength(4);
    expect(screen.container.querySelectorAll(".plotline-node-state")).toHaveLength(5);

    const viewport = screen.container.querySelector<HTMLElement>(".plotline-map-viewport")!;
    expect(viewport.clientWidth).toBeLessThan(700);
    const viewer = screen.container.querySelector<HTMLElement>(".plotline-viewer")!;
    expect(viewer.getBoundingClientRect().width).toBe(700);
    expect(getComputedStyle(viewer).overflowY).toBe("auto");
    expect(viewer.scrollHeight).toBeGreaterThan(viewer.clientHeight);
    expect(
      getComputedStyle(
        screen.container.querySelector(".plotline-under")!,
      ).gridTemplateColumns.split(" "),
    ).toHaveLength(1);
    expect(screen.getByText(/Compilation completed/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: /Verify/ }));
    expect(screen.getByText("Run lié")).toBeVisible();
    expect(screen.getByText("run-verify")).toBeVisible();
    expect(screen.container.querySelector(".plotline-inspect-grid")?.textContent).toContain(
      "Dépendances",
    );
    const mutationButtons = [...screen.container.querySelectorAll("button")].filter((button) =>
      /modifier|supprimer|créer/i.test(
        button.textContent ?? button.getAttribute("aria-label") ?? "",
      ),
    );
    expect(mutationButtons).toHaveLength(0);
    screen.container.querySelector(".plotline-inspect")!.scrollIntoView({ block: "end" });
    await expect.element(screen.getByText("run-verify")).toBeInViewport();
    expect(viewer.scrollTop).toBeGreaterThan(0);
    const narrowContainer = document.createElement("div");
    narrowContainer.style.width = "420px";
    narrowContainer.style.height = "700px";
    await using narrowScreen = await render(<PlotlineViewer dag={parallelDag} />, {
      container: narrowContainer,
      router: false,
    });
    const narrowViewport =
      narrowScreen.container.querySelector<HTMLElement>(".plotline-map-viewport")!;
    expect(
      narrowScreen.container.querySelector(".plotline-viewer")!.getBoundingClientRect().width,
    ).toBe(420);
    expect(narrowViewport.clientWidth).toBeLessThan(420);
    expect(narrowViewport.scrollWidth).toBeGreaterThan(narrowViewport.clientWidth);
    expect(narrowScreen.container.querySelectorAll(".plotline-effort-dots i")).toHaveLength(25);
    const maximizedContainer = document.createElement("div");
    maximizedContainer.style.width = "1280px";
    maximizedContainer.style.height = "720px";
    await using maximizedScreen = await render(<PlotlineViewer dag={parallelDag} maximized />, {
      container: maximizedContainer,
      router: false,
    });
    const maximizedViewer =
      maximizedScreen.container.querySelector<HTMLElement>(".plotline-viewer")!;
    expect(maximizedViewer.getBoundingClientRect().width).toBe(1280);
  });
});
