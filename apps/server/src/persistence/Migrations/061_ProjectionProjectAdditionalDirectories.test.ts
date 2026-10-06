import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("061_ProjectionProjectAdditionalDirectories", (it) => {
  it.effect("adds the nullable additional directories JSON to project projections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 60 });
      yield* runMigrations({ toMigrationInclusive: 61 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_projects)
      `;
      const additionalDirectories = columns.find(
        (column) => column.name === "additional_directories_json",
      );

      assert.equal(additionalDirectories?.name, "additional_directories_json");
      assert.equal(additionalDirectories?.notnull, 0);
    }),
  );
});
