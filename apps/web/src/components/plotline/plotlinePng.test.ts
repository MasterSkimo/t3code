import { describe, expect, it, vi } from "vite-plus/test";

import { plotlinePngFilename, pngCanvasSize, renderPlotlinePng } from "./plotlinePng";

describe("Plotline PNG export", () => {
  it("draws supplied route geometry and compact child markers", () => {
    const moveTo = vi.fn();
    const arc = vi.fn();
    const context = new Proxy(
      { moveTo, arc, measureText: (text: string) => ({ width: text.length * 5 }) },
      {
        get(target, property) {
          return Reflect.get(target, property) ?? vi.fn();
        },
      },
    );
    vi.stubGlobal("document", { createElement: () => ({ getContext: () => context }) });
    try {
      const task = {
        id: "A",
        parentId: null,
        title: "A",
        kind: "plan" as const,
        status: "completed",
        provider: null,
        detail: "",
        result: null,
      };
      renderPlotlinePng({
        title: "Plan",
        nodes: [{ node: task, x: 0, y: 0 }],
        edges: [],
        dependencies: [],
        width: 500,
        height: 300,
        dark: true,
        routes: [
          {
            from: "A",
            to: "B",
            kind: "dependency",
            points: [
              { x: 300, y: 200 },
              { x: 400, y: 200 },
            ],
          },
        ],
        compactChildren: new Map([["A", [{ ...task, id: "A1", status: "failed" }]]]),
      });
      expect(moveTo).toHaveBeenCalledWith(300, 200);
      expect(arc).toHaveBeenCalledWith(14, 94, 4, 0, Math.PI * 2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("creates portable filenames from conversation titles", () => {
    const date = new Date("2026-10-31T08:30:00.000Z");
    expect(plotlinePngFilename("Mutation dynamique du DAG natif", date)).toBe(
      "plotline-mutation-dynamique-du-dag-natif-2026-10-31.png",
    );
    expect(plotlinePngFilename("  Révision / A1 : B ? ", date)).toBe(
      "plotline-revision-a1-b-2026-10-31.png",
    );
    expect(plotlinePngFilename("🔥", date)).toBe("plotline-dag-2026-10-31.png");
  });

  it("exports an entire graph at 2x resolution when it fits the canvas budget", () => {
    expect(pngCanvasSize(400, 1000)).toEqual({
      width: 800,
      height: 2000,
      scale: 2,
    });
  });

  it("reduces image resolution for large DAGs and rejects excessive allocations", () => {
    const size = pngCanvasSize(10_000, 10_000);
    expect(size.width).toBeLessThanOrEqual(12_000);
    expect(size.height).toBeLessThanOrEqual(12_000);
    expect(size.width * size.height).toBeLessThanOrEqual(32_000_000);
    expect(() => pngCanvasSize(20_000, 20_000)).toThrow(/too large/);
    expect(() => pngCanvasSize(0, 100)).toThrow(/no exportable area/);
  });
});
