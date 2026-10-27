import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import Migration0071 from "./071_Harness.ts";

describe("071_Harness", () => {
  it.effect("creates proposal, audit, defaults, and budget tables", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Migration0071;
      const tables = yield* sql<{
        readonly name: string;
      }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'harness_%' ORDER BY name`;
      assert.deepStrictEqual(
        tables.map(({ name }) => name),
        [
          "harness_analysis_attempts",
          "harness_analysis_budget",
          "harness_audit",
          "harness_defaults",
          "harness_proposals",
        ],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
