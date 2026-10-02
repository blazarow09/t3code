import type { OrchestrationRpcSchemas, OrchestrationThreadShell } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { SqlClient } from "effect/unstable/sql";
import { supportsPromptSuggestionsDriver } from "@t3tools/shared/promptSuggestions";

import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderInstanceRegistry from "./provider/Services/ProviderInstanceRegistry.ts";
import * as ServerSettings from "./serverSettings.ts";

type Input = typeof OrchestrationRpcSchemas.getPromptSuggestion.input.Type;
type Result = typeof OrchestrationRpcSchemas.getPromptSuggestion.output.Type;
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

function isEligible(thread: OrchestrationThreadShell, input: Input, now: number) {
  const turn = thread.latestTurn;
  return (
    turn?.turnId === input.turnId &&
    turn.state === "completed" &&
    turn.completedAt !== null &&
    now - Date.parse(turn.completedAt) <= FRESH_TURN_MS &&
    thread.archivedAt === null &&
    !thread.hasPendingApprovals &&
    !thread.hasPendingUserInput &&
    !thread.hasActionableProposedPlan &&
    !thread.backgroundLiveness &&
    (thread.session === null ||
      ((thread.session.status === "ready" || thread.session.status === "idle") &&
        thread.session.activeTurnId === null &&
        thread.session.lastError === null))
  );
}

/** Construct once for the server, so all clients share in-flight and completed requests. */
export const makePromptSuggestions = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const projection = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const sql = yield* SqlClient.SqlClient;
  const scope = yield* Scope.Scope;
  const cache = new Map<string, { createdAt: number; result: Deferred.Deferred<Result> }>();

  const resolve = Effect.fn("PromptSuggestions.resolve")(function* (input: Input) {
    const settings = yield* settingsService.getSettings;
    if (!settings.promptSuggestionsEnabled) return null;
    const found = yield* projection.getThreadShellById(input.threadId);
    if (Option.isNone(found)) return null;
    const thread = found.value;
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
      input.turnId,
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
          SELECT substr(user.text, 1, 2000) AS "userMessage",
                 substr(assistant.text, -4000) AS "assistantMessage"
          FROM projection_turns AS turn
          JOIN projection_thread_messages AS user
            ON user.thread_id = turn.thread_id AND user.message_id = turn.pending_message_id
          JOIN projection_thread_messages AS assistant
            ON assistant.thread_id = turn.thread_id AND assistant.message_id = turn.assistant_message_id
          WHERE turn.thread_id = ${input.threadId} AND turn.turn_id = ${input.turnId}
            AND turn.state = 'completed' AND user.role = 'user' AND assistant.role = 'assistant'
            AND assistant.is_streaming = 0
            AND NOT EXISTS (
              SELECT 1 FROM projection_turns AS pending
              WHERE pending.thread_id = turn.thread_id AND pending.state = 'pending'
            )
            AND NOT EXISTS (
              SELECT 1 FROM projection_thread_messages AS newer
              WHERE newer.thread_id = turn.thread_id AND newer.role = 'user'
                AND (newer.created_at > user.created_at OR
                  (newer.created_at = user.created_at AND newer.message_id > user.message_id))
            )
          LIMIT 1
        `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(PromptContext)));
        const messages = rows[0];
        if (!messages?.userMessage.trim() || !messages.assistantMessage.trim()) return empty;
        const project = yield* projection.getProjectShellById(context.thread.projectId);
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
