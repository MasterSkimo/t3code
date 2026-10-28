import { describe, expect, it } from "vite-plus/test";

import { resolveAppRouteHref } from "./appRouteLink";

describe("resolveAppRouteHref", () => {
  it("preserves app paths, query strings, and fragments", () => {
    expect(resolveAppRouteHref("/dags?dagId=dag-123#task-a")).toBe("/dags?dagId=dag-123#task-a");
  });

  it("rejects protocol-relative and non-root-relative links", () => {
    expect(resolveAppRouteHref("//example.com/dags")).toBeNull();
    expect(resolveAppRouteHref("https://example.com/dags")).toBeNull();
    expect(resolveAppRouteHref("dags?dagId=dag-123")).toBeNull();
  });
});
