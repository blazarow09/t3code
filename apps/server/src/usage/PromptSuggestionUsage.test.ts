import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as Store from "./PromptSuggestionUsage.ts";
import { layerMemory } from "../persistence/Sqlite.ts";
import { parseRateTable } from "./usagePricing.ts";

const layer = Store.layer.pipe(Layer.provide(layerMemory));
const claim = { key: "turn-1", provider: "codex" as const, instanceId: "account", model: "small" };
const totals = {
  uncachedInputTokens: 100,
  cachedInputTokens: 200,
  cacheCreationTokens: 0,
  outputTokens: 20,
  reasoningTokens: 5,
};
const options = {
  timeZone: "UTC",
  sinceDay: "1970-01-01",
  untilDay: "1970-01-02",
  rates: parseRateTable({
    small: {
      input_cost_per_token: 0.001,
      cache_read_input_token_cost: 0.0001,
      output_cost_per_token: 0.002,
    },
  }),
};

it.effect(
  "claims a request atomically and returns the saved suggestion without another charge",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.PromptSuggestionUsage;
      const claims = yield* Effect.all([store.claim(claim), store.claim(claim)], {
        concurrency: "unbounded",
      });
      assert.strictEqual(claims.filter((result) => result.claimed).length, 1);
      yield* store.finish({
        key: claim.key,
        outcome: "generated",
        suggestion: "Test it",
        usage: { totals },
      });
      assert.deepStrictEqual(yield* store.claim(claim), { claimed: false, suggestion: "Test it" });
      const summary = yield* store.readSummary(options);
      assert.strictEqual(summary.rows[0]?.requests, 1);
      assert.strictEqual(summary.rows[0]?.generated, 1);
      assert.strictEqual(summary.rows[0]?.usageReportedRequests, 1);
      assert.deepStrictEqual(summary.rows[0]?.totals, totals);
      assert.approximately(summary.rows[0]!.costUsd, 0.16, 1e-9);
    }).pipe(Effect.provide(layer)),
);

it.effect("counts failed and unfinished attempts without presenting unknown usage as free", () =>
  Effect.gen(function* () {
    const store = yield* Store.PromptSuggestionUsage;
    yield* store.claim(claim);
    yield* store.claim({ ...claim, key: "turn-2" });
    yield* store.finish({
      key: claim.key,
      outcome: "timedOut",
      suggestion: null,
      usage: undefined,
    });
    const [row] = (yield* store.readSummary(options)).rows;
    assert.strictEqual(row?.requests, 2);
    assert.strictEqual(row?.failed, 1);
    assert.strictEqual(row?.incomplete, 1);
    assert.strictEqual(row?.usageReportedRequests, 0);
    assert.strictEqual(row?.unpricedRequests, 2);
    assert.isFalse((yield* store.claim({ ...claim, key: "turn-2" })).claimed);
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps reported usage on failures, honors costs and marks missing model prices", () =>
  Effect.gen(function* () {
    const store = yield* Store.PromptSuggestionUsage;
    yield* store.claim(claim);
    yield* store.finish({
      key: claim.key,
      outcome: "failed",
      suggestion: null,
      usage: { totals, costUsd: 0.25 },
    });
    yield* store.claim({ ...claim, key: "turn-2", model: "unknown" });
    yield* store.finish({ key: "turn-2", outcome: "empty", suggestion: null, usage: { totals } });
    const rows = (yield* store.readSummary(options)).rows;
    assert.strictEqual(rows.find((r) => r.model === "small")?.costUsd, 0.25);
    assert.strictEqual(rows.find((r) => r.model === "small")?.failed, 1);
    assert.strictEqual(rows.find((r) => r.model === "unknown")?.unpricedRequests, 1);
    const mapped = yield* store.readSummary({
      ...options,
      modelAliases: new Map([["unknown", "small"]]),
    });
    assert.strictEqual(mapped.rows.length, 1);
    assert.strictEqual(mapped.rows[0]?.requests, 2);
    assert.approximately(mapped.rows[0]!.costUsd, 0.41, 1e-9);
  }).pipe(Effect.provide(layer)),
);

it.effect("uses local days and exact exclusive hour windows", () =>
  Effect.gen(function* () {
    const store = yield* Store.PromptSuggestionUsage;
    yield* TestClock.adjust("23 hours");
    yield* store.claim(claim);
    const local = {
      ...options,
      timeZone: "Europe/Sofia",
      sinceDay: "1970-01-02",
      untilDay: "1970-01-02",
    };
    assert.strictEqual((yield* store.readSummary(local)).rows[0]?.requests, 1);
    assert.deepStrictEqual(
      (yield* store.readSummary({ ...local, sinceDay: "1970-01-01", untilDay: "1970-01-01" })).rows,
      [],
    );
    const hourly = {
      ...options,
      resolution: "hour" as const,
      sinceTimeMs: 0,
      untilTimeMs: 23 * 60 * 60_000,
    };
    assert.deepStrictEqual((yield* store.readSummary(hourly)).rows, []);
    assert.strictEqual(
      (yield* store.readSummary({ ...hourly, untilTimeMs: hourly.untilTimeMs + 1 })).rows[0]
        ?.requests,
      1,
    );
  }).pipe(Effect.provide(layer)),
);
