import type { OrchestrationV2RpcSchemas, OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import { supportsPromptSuggestionsDriver } from "@t3tools/shared/promptSuggestions";
import type { TextGenerationUsage } from "@t3tools/provider-core/server/textGeneration";

import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ProviderInstanceRegistry from "./provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as SuggestionUsage from "./usage/PromptSuggestionUsage.ts";

type Input = typeof OrchestrationV2RpcSchemas.getPromptSuggestion.input.Type;
type Result = typeof OrchestrationV2RpcSchemas.getPromptSuggestion.output.Type;
const empty: Result = { suggestion: null };
const MAX_CACHED_TURNS = 512;

const PromptContext = Schema.Array(
  Schema.Struct({
    userMessage: Schema.String,
    assistantMessage: Schema.String,
  }),
);
const encodeCacheKey = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

function isEligible(thread: OrchestrationV2ThreadShell, input: Input) {
  return (
    thread.latestRunId === input.runId &&
    thread.status === "completed" &&
    thread.latestRunCompletedAt != null &&
    thread.archivedAt === null &&
    thread.activeRunId === null &&
    thread.pendingRuntimeRequest === null &&
    !thread.hasActionableProposedPlan &&
    (thread.pendingBackgroundTasks?.length ?? 0) === 0 &&
    !thread.lastError
  );
}

export class PromptSuggestions extends Context.Service<
  PromptSuggestions,
  { readonly get: (input: Input) => Effect.Effect<Result> }
>()("t3/promptSuggestions") {}

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const projection = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const sql = yield* SqlClient.SqlClient;
  const usageStore = yield* SuggestionUsage.PromptSuggestionUsage;
  const scope = yield* Scope.Scope;
  const cache = new Map<string, { completed: boolean; result: Deferred.Deferred<Result> }>();

  const resolve = Effect.fn("PromptSuggestions.resolve")(function* (input: Input) {
    const settings = yield* settingsService.getSettings;
    if (!settings.promptSuggestionsEnabled) return null;
    const found = yield* projection.getThreadShell(input.threadId);
    if (!found) return null;
    const thread = found;
    if (!isEligible(thread, input)) return null;
    const instanceId = thread.modelSelection.instanceId;
    const config = settings.providerInstances[instanceId];
    const selection = config?.promptSuggestions;
    if (!selection?.enabled || config?.enabled === false) return null;
    const instance = yield* registry.getInstance(instanceId);
    if (!instance?.enabled || !supportsPromptSuggestionsDriver(instance.driverKind)) return null;
    const provider = yield* instance.snapshot.getSnapshot;
    if (
      provider.status === "disabled" ||
      provider.status === "error" ||
      provider.availability === "unavailable" ||
      provider.auth.status === "unauthenticated" ||
      provider.usageLimits?.windows.some((window) => window.usedPercent >= 100)
    )
      return null;
    const model = provider.models.find((candidate) => candidate.slug === selection.model);
    if (!model) return null;
    const effort = model.capabilities?.optionDescriptors?.find(
      (option) => option.id === "reasoningEffort" || option.id === "effort",
    );
    const requestedEffort = selection.reasoningEffort ?? "low";
    if (
      selection.reasoningEffort &&
      (effort?.type !== "select" || !effort.options.some((option) => option.id === requestedEffort))
    )
      return null;
    const options =
      effort?.type === "select" && effort.options.some((option) => option.id === requestedEffort)
        ? [{ id: effort.id, value: requestedEffort }]
        : [];
    const modelSelection = { instanceId, model: model.slug, options };
    const key = yield* encodeCacheKey([
      input.threadId,
      input.runId,
      instanceId,
      model.slug,
      options[0]?.value ?? "",
    ]);
    return { thread, instance, modelSelection, key };
  });

  const get = Effect.fn("PromptSuggestions.get")(function* (input: Input) {
    const context = yield* resolve(input);
    if (!context) return empty;
    const pending = yield* Effect.gen(function* () {
      const existing = cache.get(context.key);
      if (existing) return existing.result;
      if (cache.size >= MAX_CACHED_TURNS) {
        const oldestCompleted = [...cache].find(([, entry]) => entry.completed);
        if (!oldestCompleted) return null;
        cache.delete(oldestCompleted[0]);
      }
      const pending = Deferred.makeUnsafe<Result>();
      const entry = { completed: false, result: pending };
      cache.set(context.key, entry);
      const result = pending;
      let claimed = false;
      let usage: TextGenerationUsage | undefined;
      let suggestion: string | null = null;
      let outcome: Parameters<typeof usageStore.finish>[0]["outcome"] = "interrupted";
      const generate = Effect.gen(function* () {
        // Only fetch two bounded text fields; never hydrate the conversation or tool logs.
        const rows = yield* sql`
          SELECT substr(json_extract(user.payload_json, '$.text'), 1, 2000) AS "userMessage",
                 substr(json_extract(assistant.payload_json, '$.text'), -4000) AS "assistantMessage"
          FROM orchestration_v2_projection_runs AS run
          JOIN orchestration_v2_projection_messages AS user ON user.thread_id = run.thread_id AND user.message_id = json_extract(run.payload_json, '$.userMessageId')
          JOIN orchestration_v2_projection_messages AS assistant ON assistant.thread_id = run.thread_id AND assistant.run_id = run.run_id AND assistant.role = 'assistant'
          WHERE run.thread_id = ${input.threadId} AND run.run_id = ${input.runId} AND run.status = 'completed' AND assistant.streaming = 0
            AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_runs AS pending WHERE pending.thread_id = run.thread_id AND pending.status IN ('queued','preparing','starting','running','waiting'))
            AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_messages AS newer WHERE newer.thread_id = run.thread_id AND newer.role = 'user' AND newer.created_at > user.created_at)
          ORDER BY assistant.created_at DESC, assistant.message_id DESC LIMIT 1
        `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(PromptContext)));
        const messages = rows[0];
        if (!messages?.userMessage.trim() || !messages.assistantMessage.trim()) return empty;
        const project = yield* projects.get(context.thread.projectId);
        if (Option.isNone(project)) return empty;
        const claim = yield* usageStore.claim({
          key: context.key,
          provider:
            context.instance.driverKind === "claudeAgent"
              ? "claude"
              : context.instance.driverKind === "antigravity"
                ? "antigravity"
                : "codex",
          instanceId: context.modelSelection.instanceId,
          model: context.modelSelection.model,
        });
        if (!claim.claimed) return { suggestion: claim.suggestion };
        claimed = true;
        const generated = yield* context.instance.textGeneration.generatePromptSuggestion({
          ...messages,
          cwd: context.thread.worktreePath ?? project.value.workspaceRoot,
          modelSelection: context.modelSelection,
          onUsage: (reported) => {
            usage = reported;
          },
        });
        suggestion = generated.suggestion;
        outcome = suggestion === null ? "empty" : "generated";
        return generated;
      }).pipe(
        Effect.timeout("20 seconds"),
        Effect.catchTags({
          TimeoutError: () =>
            Effect.sync(() => {
              outcome = "timedOut";
              return empty;
            }),
        }),
        Effect.catch(() =>
          Effect.sync(() => {
            outcome = "failed";
            return empty;
          }),
        ),
        Effect.catchDefect(() =>
          Effect.sync(() => {
            outcome = "failed";
            return empty;
          }),
        ),
        Effect.ensuring(
          Effect.suspend(() =>
            claimed
              ? usageStore
                  .finish({ key: context.key, outcome, suggestion, usage })
                  .pipe(
                    Effect.catch(() =>
                      Effect.logWarning("Could not save prompt suggestion usage."),
                    ),
                  )
              : Effect.void,
          ),
        ),
        Effect.flatMap((value) => Deferred.succeed(result, value)),
        // Interruption is not an error or defect. Always release clients waiting
        // on this cache entry, even if the provider interrupts its own worker.
        Effect.ensuring(
          Effect.gen(function* () {
            entry.completed = true;
            yield* Deferred.succeed(result, empty);
          }),
        ),
      );
      // A client disconnect must not restart a billed request from another client.
      yield* generate.pipe(Effect.interruptible, Effect.forkIn(scope));
      return pending;
    }).pipe(Effect.uninterruptible);
    if (!pending) return empty;
    const result = yield* Deferred.await(pending);
    const current = yield* resolve(input);
    return current?.key === context.key && current.instance === context.instance ? result : empty;
  });

  return PromptSuggestions.of({
    get: (input) => get(input).pipe(Effect.orElseSucceed(() => empty)),
  });
});

/** Own the worker and cache for the server lifetime, beyond any one client connection. */
export const layer = Layer.effect(PromptSuggestions, make).pipe(
  Layer.provide(SuggestionUsage.layer),
);
