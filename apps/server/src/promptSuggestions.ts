import type { OrchestrationV2RpcSchemas, OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as DateTime from "effect/DateTime";
import { supportsPromptSuggestionsDriver } from "@t3tools/shared/promptSuggestions";

import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ProviderInstanceRegistry from "./provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "./serverSettings.ts";

type Input = typeof OrchestrationV2RpcSchemas.getPromptSuggestion.input.Type;
type Result = typeof OrchestrationV2RpcSchemas.getPromptSuggestion.output.Type;
const empty: Result = { suggestion: null };
// Old conversations never launch background work when reopened. Keeping results
// longer than the eligibility window also bounds memory without regenerating them.
const FRESH_TURN_MS = 5 * 60_000;
const MAX_CACHED_TURNS = 512;

const PromptContext = Schema.Array(
  Schema.Struct({
    userMessage: Schema.String,
    assistantMessage: Schema.String,
  }),
);
const encodeCacheKey = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

function isEligible(thread: OrchestrationV2ThreadShell, input: Input, now: number) {
  return (
    thread.latestRunId === input.runId &&
    thread.status === "idle" &&
    thread.latestRunCompletedAt != null &&
    now - DateTime.toEpochMillis(thread.latestRunCompletedAt) <= FRESH_TURN_MS &&
    thread.archivedAt === null &&
    thread.activeRunId === null &&
    thread.pendingRuntimeRequest === null &&
    !thread.hasActionableProposedPlan &&
    (thread.pendingBackgroundTasks?.length ?? 0) === 0 &&
    !thread.lastError
  );
}

/** Construct once for the server, so all clients share in-flight and completed requests. */
export const makePromptSuggestions = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const projection = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const sql = yield* SqlClient.SqlClient;
  const scope = yield* Scope.Scope;
  const cache = new Map<string, { createdAt: number; result: Deferred.Deferred<Result> }>();

  const resolve = Effect.fn("PromptSuggestions.resolve")(function* (input: Input) {
    const settings = yield* settingsService.getSettings;
    if (!settings.promptSuggestionsEnabled) return null;
    const found = yield* projection.getThreadShell(input.threadId);
    if (!found) return null;
    const thread = found;
    if (!isEligible(thread, input, yield* Clock.currentTimeMillis)) return null;
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
    const now = yield* Clock.currentTimeMillis;
    for (const [key, entry] of cache) {
      if (now - entry.createdAt > FRESH_TURN_MS * 2) cache.delete(key);
    }
    const pending = yield* Effect.gen(function* () {
      const existing = cache.get(context.key);
      if (existing) return existing.result;
      if (cache.size >= MAX_CACHED_TURNS) return null;
      const pending = Deferred.makeUnsafe<Result>();
      cache.set(context.key, { createdAt: now, result: pending });
      const result = pending;
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
        return yield* context.instance.textGeneration.generatePromptSuggestion({
          ...messages,
          cwd: context.thread.worktreePath ?? project.value.workspaceRoot,
          modelSelection: context.modelSelection,
        });
      }).pipe(
        Effect.timeout("20 seconds"),
        Effect.orElseSucceed(() => empty),
        Effect.catchDefect(() => Effect.succeed(empty)),
        Effect.flatMap((value) => Deferred.succeed(result, value)),
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

  return (input: Input) => get(input).pipe(Effect.orElseSucceed(() => empty));
});
