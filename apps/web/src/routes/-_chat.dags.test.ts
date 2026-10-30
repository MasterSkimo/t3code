import { describe, expect, it } from "vite-plus/test";

import { validateDagsSearch } from "./_chat.dags";

describe("DAG route search", () => {
  it("supports the existing chat link without a selected DAG", () => {
    expect(validateDagsSearch({})).toEqual({});
  });

  it("keeps a selected DAG id for deep links", () => {
    expect(validateDagsSearch({ dagId: "dag-123" })).toEqual({ dagId: "dag-123" });
  });

  it("drops a blank selected DAG id", () => {
    expect(validateDagsSearch({ dagId: " " })).toEqual({});
  });
});
