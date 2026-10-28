import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { Route as DagsRoute } from "../routes/_chat.dags";

function matchedSearch(url: string) {
  const root = createRootRoute();
  const chat = createRoute({ getParentRoute: () => root, id: "_chat" });
  const dags = createRoute({
    getParentRoute: () => chat,
    path: "dags",
    validateSearch: DagsRoute.options.validateSearch,
  });
  const router = createRouter({
    routeTree: root.addChildren([chat.addChildren([dags])]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  return router.matchRoutes(router.latestLocation).at(-1)?.search as
    | Record<string, unknown>
    | undefined;
}

describe("DAG route search", () => {
  it("supports the existing chat link without a selected DAG", () => {
    expect(matchedSearch("/dags")).toEqual({});
  });

  it("keeps a selected DAG id for deep links", () => {
    expect(matchedSearch("/dags?dagId=dag-123")?.dagId).toBe("dag-123");
  });
});
