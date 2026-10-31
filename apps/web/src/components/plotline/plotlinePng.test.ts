import { describe, expect, it } from "vite-plus/test";

import { plotlinePngFilename, pngCanvasSize } from "./plotlinePng";

describe("Plotline PNG export", () => {
  it("creates portable filenames from conversation titles", () => {
    const date = new Date("2026-10-31T08:30:00.000Z");
    expect(plotlinePngFilename("Mutation dynamique du DAG natif", date))
      .toBe("plotline-mutation-dynamique-du-dag-natif-2026-10-31.png");
    expect(plotlinePngFilename("  Révision / A1 : B ? ", date))
      .toBe("plotline-revision-a1-b-2026-10-31.png");
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
