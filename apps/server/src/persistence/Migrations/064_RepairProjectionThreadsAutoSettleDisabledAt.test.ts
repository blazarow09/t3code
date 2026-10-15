import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import migrateSuggestionUsage from "./065_PromptSuggestionUsage.ts";
import migrateProjectAdditionalDirectories from "./063_ProjectionProjectAdditionalDirectories.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "064_RepairProjectionThreadsAutoSettleDisabledAt",
  (it) => {
    it.effect("upgrades custom ids 61 through 63 without losing suggestion usage", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 60 });
        yield* migrateProjectAdditionalDirectories;
        yield* migrateSuggestionUsage;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES
          (61, 'ProjectionProjectAdditionalDirectories'),
          (62, 'RepairProjectionThreadsAutoSettleDisabledAt'),
          (63, 'PromptSuggestionUsage')`;
        const meta = yield* sql`SELECT * FROM prompt_suggestion_usage_meta`;
        yield* sql`INSERT INTO prompt_suggestion_usage
          (cache_key, provider, instance_id, model, started_at, outcome)
          VALUES ('retained', 'codex', 'codex', 'test-model', 1, 'generated')`;
        yield* runMigrations();
        assert.deepEqual(yield* sql`SELECT * FROM prompt_suggestion_usage_meta`, meta);
        assert.deepEqual(yield* sql`SELECT cache_key FROM prompt_suggestion_usage`, [
          { cache_key: "retained" },
        ]);
        assert.deepEqual(
          yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 61 ORDER BY migration_id`,
          [
            { migration_id: 61, name: "PullRequestReviewGuides" },
            { migration_id: 62, name: "ThreadFailureLookupIndex" },
            { migration_id: 63, name: "ProjectionProjectAdditionalDirectories" },
            { migration_id: 64, name: "RepairProjectionThreadsAutoSettleDisabledAt" },
            { migration_id: 65, name: "PromptSuggestionUsage" },
          ],
        );
        assert.deepEqual(yield* runMigrations(), []);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
    );
    it.effect("upgrades custom migrations 55 and 56 while preserving project folders", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 54 });
        yield* migrateProjectAdditionalDirectories;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES
          (55, 'ProjectionProjectAdditionalDirectories'),
          (56, 'RepairProjectionThreadsAutoSettleDisabledAt')`;
        yield* sql`INSERT INTO projection_projects
          (project_id, title, workspace_root, scripts_json, created_at, updated_at, additional_directories_json)
          VALUES ('custom-project', 'Custom', '/tmp/custom', '[]', '2026-01-01', '2026-01-01', '["/tmp/extra"]')`;
        yield* runMigrations();
        assert.deepEqual(
          yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 55`,
          [{ name: "OrchestrationV2" }],
        );
        assert.deepEqual(
          yield* sql`SELECT additional_directories_json FROM projection_projects WHERE project_id = 'custom-project'`,
          [{ additional_directories_json: '["/tmp/extra"]' }],
        );
        assert.deepEqual(yield* runMigrations(), []);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
    );
    it.effect(
      "repairs a database where old custom migration 54 skipped upstream migration 54",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* runMigrations({ toMigrationInclusive: 53 });
          yield* migrateProjectAdditionalDirectories;
          yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (54, 'ProjectionProjectAdditionalDirectories')
        `;
          const now = "2026-01-01T00:00:00.000Z";
          yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            created_at, updated_at
          ) VALUES (
            'thread-1', 'project-1', 'Existing thread',
            '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', ${now}, ${now}
          )
        `;

          yield* runMigrations();

          const rows = yield* sql<{ readonly autoSettleDisabledAt: string | null }>`
          SELECT auto_settle_disabled_at AS "autoSettleDisabledAt"
          FROM projection_threads WHERE thread_id = 'thread-1'
        `;
          assert.deepEqual(rows, [{ autoSettleDisabledAt: null }]);
          yield* sql`UPDATE projection_threads SET auto_settle_disabled_at = ${now} WHERE thread_id = 'thread-1'`;
          yield* runMigrations();
          const preserved = yield* sql<{ readonly autoSettleDisabledAt: string | null }>`
          SELECT auto_settle_disabled_at AS "autoSettleDisabledAt"
          FROM projection_threads WHERE thread_id = 'thread-1'
        `;
          assert.deepEqual(preserved, [{ autoSettleDisabledAt: now }]);
        }),
    );
  },
);
