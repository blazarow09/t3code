import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE prompt_suggestion_usage_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      source_id TEXT NOT NULL,
      tracking_since TEXT NOT NULL
    )
  `;
  yield* sql`INSERT INTO prompt_suggestion_usage_meta VALUES
    (1, lower(hex(randomblob(16))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;
  yield* sql`
    CREATE TABLE prompt_suggestion_usage (
      cache_key TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      model TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      outcome TEXT NOT NULL,
      suggestion TEXT,
      usage_json TEXT
    )
  `;
  yield* sql`CREATE INDEX prompt_suggestion_usage_started_at ON prompt_suggestion_usage (started_at)`;
});
