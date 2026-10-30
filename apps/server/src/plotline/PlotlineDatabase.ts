/**
 * Extension database at <stateDir>/plotline.sqlite.
 * It has no connection to T3's statev2.sqlite and no upstream migration IDs.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { ServerConfig } from "../config.ts";
import * as Migration001 from "./migrations/001_DagSnapshots.ts";

const MIGRATIONS: ReadonlyArray<{
  readonly version: number;
  readonly statements: ReadonlyArray<string>;
}> = [{ version: Migration001.VERSION, statements: Migration001.STATEMENTS }];

/** Append-only migration runner with transactional version tracking. */
export const migratePlotlineDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS plotline_schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`;
  const applied = new Set(
    (yield* sql<{ readonly version: number }>`SELECT version FROM plotline_schema_migrations`)
      .map((row) => row.version),
  );
  const latestKnown = MIGRATIONS.at(-1)?.version ?? 0;
  if ([...applied].some((version) => version > latestKnown)) {
    return yield* Effect.fail(new Error("Plotline database was created by a newer extension version."));
  }
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const statement of migration.statements) yield* sql.unsafe(statement);
        yield* sql`INSERT INTO plotline_schema_migrations (version, applied_at)
          VALUES (${migration.version}, ${DateTime.formatIso(DateTime.toUtc(yield* DateTime.now))})`;
      }),
    );
  }
});

const setup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA busy_timeout = 5000`;
    yield* sql`PRAGMA foreign_keys = ON`;
    yield* sql`PRAGMA journal_mode = WAL`;
    yield* migratePlotlineDatabase;
  }),
);

export const layerFromFilename = (filename: string) =>
  Layer.provideMerge(
    setup,
    NodeSqliteClient.layer({
      filename,
      spanAttributes: {
        "db.name": "plotline.sqlite",
        "service.name": "t3code-server",
      },
    }),
  );

/** Independent in-memory database for migration and persistence tests. */
export const layerMemory = layerFromFilename(":memory:");

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(stateDir, { recursive: true });
    return layerFromFilename(path.join(stateDir, "plotline.sqlite"));
  }),
);
