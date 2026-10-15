import {
  UsageTokenTotals,
  type PromptSuggestionUsage as Summary,
  type PromptSuggestionUsageRow,
  type UsageProviderKind,
} from "@t3tools/contracts";
import type { TextGenerationUsage } from "@t3tools/provider-core/server/textGeneration";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { UsageAggregator, type AggregateOptions } from "./usageAggregation.ts";
import { EMPTY_TOTALS } from "@t3tools/provider-core/server/usage";
import { priceUsage } from "./usagePricing.ts";

type Outcome = "generated" | "empty" | "failed" | "timedOut" | "interrupted";
interface Claim {
  readonly key: string;
  readonly provider: UsageProviderKind;
  readonly instanceId: string;
  readonly model: string;
}

export class PromptSuggestionUsageError extends Schema.TaggedError<PromptSuggestionUsageError>()(
  "PromptSuggestionUsageError",
  {
    operation: Schema.Literals(["claim", "finish", "read"]),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return "Could not record or read prompt suggestion usage.";
  }
}

export class PromptSuggestionUsage extends Context.Service<
  PromptSuggestionUsage,
  {
    readonly claim: (
      input: Claim,
    ) => Effect.Effect<
      { readonly claimed: boolean; readonly suggestion: string | null },
      PromptSuggestionUsageError
    >;
    readonly finish: (input: {
      readonly key: string;
      readonly outcome: Outcome;
      readonly suggestion: string | null;
      readonly usage: TextGenerationUsage | undefined;
    }) => Effect.Effect<void, PromptSuggestionUsageError>;
    readonly readSummary: (
      options: AggregateOptions,
    ) => Effect.Effect<Summary, PromptSuggestionUsageError>;
  }
>()("t3/usage/PromptSuggestionUsage") {}

const ReportedUsage = Schema.Struct({
  totals: UsageTokenTotals,
  model: Schema.optional(Schema.String),
  costUsd: Schema.optional(Schema.Number),
  speed: Schema.optional(Schema.Literals(["standard", "fast", "ultrafast"])),
});
const encodeUsage = Schema.encodeEffect(Schema.fromJsonString(ReportedUsage));
const decodeUsage = Schema.decodeUnknownOption(Schema.fromJsonString(ReportedUsage));
const groupKey = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const claim = Effect.fn("PromptSuggestionUsage.claim")(function* (input: Claim) {
    const now = yield* Clock.currentTimeMillis;
    const inserted = yield* sql`
      INSERT INTO prompt_suggestion_usage
        (cache_key, provider, instance_id, model, started_at, outcome)
      VALUES (${input.key}, ${input.provider}, ${input.instanceId}, ${input.model}, ${now}, 'started')
      ON CONFLICT (cache_key) DO NOTHING RETURNING cache_key
    `;
    if (inserted.length > 0) return { claimed: true, suggestion: null };
    // A crashed or interrupted attempt is not retried: its provider may already
    // have charged for it. Completed results survive server restarts as well.
    const rows = yield* sql<{ suggestion: string | null }>`
      SELECT suggestion FROM prompt_suggestion_usage WHERE cache_key = ${input.key}
    `;
    return { claimed: false, suggestion: rows[0]?.suggestion ?? null };
  });

  const finish = Effect.fn("PromptSuggestionUsage.finish")(function* (
    input: Parameters<PromptSuggestionUsage["Service"]["finish"]>[0],
  ) {
    const encoded = input.usage === undefined ? null : yield* encodeUsage(input.usage);
    yield* sql`
      UPDATE prompt_suggestion_usage SET outcome = ${input.outcome},
        suggestion = ${input.suggestion}, usage_json = ${encoded}
      WHERE cache_key = ${input.key}
    `;
  });

  const readSummary = Effect.fn("PromptSuggestionUsage.readSummary")(function* (
    options: AggregateOptions,
  ) {
    // The indexed coarse window includes every timezone; the aggregator applies
    // exact local-day or rolling-hour bounds before a request contributes.
    const from = options.sinceTimeMs ?? Date.parse(options.sinceDay) - 36 * 60 * 60_000;
    const until = options.untilTimeMs ?? Date.parse(options.untilDay) + 60 * 60 * 60_000;
    const records = yield* sql<{
      cache_key: string;
      provider: UsageProviderKind;
      instance_id: string;
      model: string;
      started_at: number;
      outcome: string;
      usage_json: string | null;
    }>`SELECT cache_key, provider, instance_id, model, started_at, outcome, usage_json
      FROM prompt_suggestion_usage WHERE started_at >= ${from} AND started_at < ${until}`;
    const [meta] = yield* sql<{ source_id: string; tracking_since: string }>`
      SELECT source_id, tracking_since FROM prompt_suggestion_usage_meta WHERE id = 1
    `;
    if (!meta) return yield* Effect.die("Missing prompt suggestion usage metadata");
    const aggregator = new UsageAggregator(options);
    const rows = new Map<string, PromptSuggestionUsageRow>();
    for (const record of records) {
      const decoded = record.usage_json === null ? Option.none() : decodeUsage(record.usage_json);
      const usage = Option.getOrUndefined(decoded);
      const reportedModel = usage?.model?.trim() || record.model;
      const model = options.modelAliases?.get(reportedModel) ?? reportedModel;
      const totals = usage?.totals ?? EMPTY_TOTALS;
      const pricedRecord = {
        provider: record.provider,
        timestampMs: record.started_at,
        model,
        sessionId: record.cache_key,
        dedupeKey: record.cache_key,
        totals,
        reportedCostUsd: usage?.costUsd ?? null,
        speed: usage?.speed ?? ("standard" as const),
      };
      if (!aggregator.add(pricedRecord)) continue;
      const key = groupKey([record.provider, record.instance_id, model]);
      const current = rows.get(key);
      const priced = priceUsage(options.rates, pricedRecord, options.priceOverrides);
      rows.set(key, {
        provider: record.provider,
        instanceId: record.instance_id,
        model,
        requests: (current?.requests ?? 0) + 1,
        generated: (current?.generated ?? 0) + Number(record.outcome === "generated"),
        failed:
          (current?.failed ?? 0) +
          Number(["failed", "timedOut", "interrupted"].includes(record.outcome)),
        incomplete: (current?.incomplete ?? 0) + Number(record.outcome === "started"),
        usageReportedRequests: (current?.usageReportedRequests ?? 0) + Number(usage !== undefined),
        unpricedRequests:
          (current?.unpricedRequests ?? 0) +
          Number(usage === undefined || priced.costSource === "unpriced"),
        costUsd: (current?.costUsd ?? 0) + (usage === undefined ? 0 : priced.costUsd),
        totals: {
          uncachedInputTokens:
            (current?.totals.uncachedInputTokens ?? 0) + totals.uncachedInputTokens,
          cachedInputTokens: (current?.totals.cachedInputTokens ?? 0) + totals.cachedInputTokens,
          cacheCreationTokens:
            (current?.totals.cacheCreationTokens ?? 0) + totals.cacheCreationTokens,
          outputTokens: (current?.totals.outputTokens ?? 0) + totals.outputTokens,
          reasoningTokens: (current?.totals.reasoningTokens ?? 0) + totals.reasoningTokens,
        },
      });
    }
    return {
      sourceId: meta.source_id,
      trackingSince: meta.tracking_since,
      rows: [...rows.values()].sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests),
    };
  });

  return PromptSuggestionUsage.of({
    claim: (input) =>
      claim(input).pipe(
        Effect.mapError((cause) => new PromptSuggestionUsageError({ operation: "claim", cause })),
      ),
    finish: (input) =>
      finish(input).pipe(
        Effect.mapError((cause) => new PromptSuggestionUsageError({ operation: "finish", cause })),
      ),
    readSummary: (input) =>
      readSummary(input).pipe(
        Effect.mapError((cause) => new PromptSuggestionUsageError({ operation: "read", cause })),
      ),
  });
});

export const layer = Layer.effect(PromptSuggestionUsage, make);
