import { EnvironmentId, ThreadId, type PlotlineDag } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";

const mocks = vi.hoisted(() => ({
  dags: [] as PlotlineDag[],
  navigate: vi.fn(),
  openPlotline: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => mocks.navigate,
}));
vi.mock("../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/environments")>()),
  usePrimaryEnvironmentId: () => EnvironmentId.make("environment-1"),
}));
vi.mock("../state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/entities")>()),
  useProjects: () => [],
}));
vi.mock("../state/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/server")>();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      plotlineDagsLive: () => ({}),
    },
  };
});
vi.mock("../state/query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/query")>()),
  useEnvironmentQuery: () => ({
    data: { dags: mocks.dags },
    error: null,
    isLoading: false,
  }),
}));
vi.mock("../rightPanelStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../rightPanelStore")>()),
  useRightPanelStore: { getState: () => ({ openPlotline: mocks.openPlotline }) },
}));
vi.mock("./plotline/PlotlineViewer", () => ({
  PlotlineViewer: ({ dag }: { dag: PlotlineDag }) => <div>{dag.title}</div>,
}));

import { PlotlineDagsPage } from "./PlotlineDagsPage";

const dag = (originatingThreadId?: string): PlotlineDag => ({
  id: "dag-1",
  projectId: "project-1",
  ...(originatingThreadId ? { originatingThreadId: ThreadId.make(originatingThreadId) } : {}),
  title: "Build release",
  description: "",
  workspace: null,
  state: "running",
  createdAt: "2026-10-27T10:00:00.000Z",
  updatedAt: "2026-10-27T10:05:00.000Z",
  startedAt: "2026-10-27T10:01:00.000Z",
  finishedAt: null,
  tasks: [
    {
      id: "compile",
      title: "Compile",
      description: "Compile the application",
      state: "running",
      effort: 3,
      dependsOn: [],
      threadId: null,
      runId: null,
      legacySessionIds: [],
      agent: null,
      createdAt: "2026-10-27T10:00:00.000Z",
      updatedAt: "2026-10-27T10:05:00.000Z",
      startedAt: "2026-10-27T10:01:00.000Z",
      finishedAt: null,
    },
  ],
  events: [],
});

describe("Plotline legacy route", () => {
  it("keeps the legacy view read-only", async () => {
    mocks.dags = [dag()];
    mocks.navigate.mockReset();
    mocks.openPlotline.mockReset();
    await using screen = await render(
      <PlotlineDagsPage selectedDagId="dag-1" onSelectDag={vi.fn()} />,
    );

    expect(screen.getByText("Build release")).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Select a DAG" })).toBeVisible();
    expect(screen.container.querySelectorAll("button")).toHaveLength(0);
    expect(screen.container.querySelectorAll("input, textarea")).toHaveLength(0);
    expect(screen.container.querySelectorAll("select")).toHaveLength(1);
    expect(mocks.openPlotline).not.toHaveBeenCalled();
  });

  it("hands an associated legacy deep link to the originating conversation panel", async () => {
    mocks.dags = [dag("thread-1")];
    mocks.navigate.mockReset();
    mocks.openPlotline.mockReset();
    await using _screen = await render(
      <PlotlineDagsPage selectedDagId="dag-1" onSelectDag={vi.fn()} />,
    );

    await vi.waitFor(() => {
      expect(mocks.openPlotline).toHaveBeenCalledWith(
        {
          environmentId: EnvironmentId.make("environment-1"),
          threadId: ThreadId.make("thread-1"),
        },
        "dag-1",
      );
      expect(mocks.navigate).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "/$environmentId/$threadId",
          params: { environmentId: "environment-1", threadId: "thread-1" },
          replace: true,
        }),
      );
    });
  });
});
