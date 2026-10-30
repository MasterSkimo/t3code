import {
  PlotlineDagSnapshot,
  PlotlineStorageError,
  type PlotlineSaveInput as PlotlineSaveInputType,
  type PlotlineDagSnapshot as PlotlineDagSnapshotType,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ForkDatabase from "../fork/ForkDatabase.ts";

const decodeSnapshot = Schema.decodeUnknownSync(Schema.fromJsonString(PlotlineDagSnapshot));
const encodeSnapshot = Schema.encodeSync(Schema.fromJsonString(PlotlineDagSnapshot));
const MAX_NODES = 500;
const MAX_PAYLOAD_BYTES = 1024 * 1024;

const failure = (message: string) => new PlotlineStorageError({ message });

export class PlotlineStore extends Context.Service<
  PlotlineStore,
  {
    readonly list: (input: { readonly threadId: string }) =>
      Effect.Effect<{ readonly dags: ReadonlyArray<PlotlineDagSnapshotType> }, PlotlineStorageError>;
    readonly save: (input: PlotlineSaveInputType) =>
      Effect.Effect<PlotlineDagSnapshotType, PlotlineStorageError>;
  }
>()("t3/plotline/PlotlineStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const list: PlotlineStore["Service"]["list"] = ({ threadId }) =>
    Effect.gen(function* () {
      if (!threadId.trim()) return yield* failure("Thread id is required.");
      const rows = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM fork_plotline_dag_snapshots
        WHERE thread_id = ${threadId} ORDER BY updated_at DESC LIMIT 100
      `.pipe(Effect.mapError(() => failure("Could not read Plotline snapshots.")));
      // A damaged snapshot must not prevent reading all other DAGs.
      const dags: PlotlineDagSnapshotType[] = [];
      for (const row of rows) {
        const decoded = yield* Effect.try({
          try: () => decodeSnapshot(row.payload_json),
          catch: () => failure("Stored Plotline DAG data is invalid."),
        }).pipe(Effect.option);
        if (decoded._tag === "Some") {
          dags.push(decoded.value);
        } else {
          yield* Effect.logWarning("Skipping an invalid fork-owned Plotline snapshot.");
        }
      }
      return { dags };
    });

  const save: PlotlineStore["Service"]["save"] = (input) =>
    Effect.gen(function* () {
      if (!input.threadId.trim() || !input.runId.trim())
        return yield* failure("Thread and run IDs are required.");
      if (input.nodes.length > MAX_NODES)
        return yield* failure("Plotline graph exceeds the node limit.");
      const validNodeIds = new Set(input.nodes.map((node) => node.id));
      if (
        validNodeIds.size !== input.nodes.length ||
        input.edges.some((edge) => !validNodeIds.has(edge.from) || !validNodeIds.has(edge.to))
      )
        return yield* failure("Plotline graph contains invalid or duplicate node IDs.");
      const now = DateTime.formatIso(DateTime.toUtc(yield* DateTime.now));
      const record: PlotlineDagSnapshotType = { ...input, updatedAt: now };
      const payload = yield* Effect.try({
        try: () => encodeSnapshot(record),
        catch: () => failure("Could not encode Plotline DAG."),
      });
      if (new TextEncoder().encode(payload).byteLength > MAX_PAYLOAD_BYTES)
        return yield* failure("Plotline graph exceeds the storage limit.");
      yield* sql`
        INSERT INTO fork_plotline_dag_snapshots
          (thread_id, run_id, payload_json, created_at, updated_at)
        VALUES (${input.threadId}, ${input.runId}, ${payload}, ${now}, ${now})
        ON CONFLICT(thread_id, run_id) DO UPDATE SET
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at
      `.pipe(Effect.mapError(() => failure("Could not persist Plotline DAG.")));
      return record;
    });

  return PlotlineStore.of({ list, save });
});

/** Service only exports PlotlineStore. The isolated SQLite client stays private. */
export const layerMemory = Layer.effect(PlotlineStore, make).pipe(
  Layer.provide(ForkDatabase.layerMemory),
);
export const layer = Layer.effect(PlotlineStore, make).pipe(
  Layer.provide(ForkDatabase.layer),
);
