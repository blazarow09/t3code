import {
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
  type ServerProvider,
  type ServerSettings as Settings,
  TextGenerationError,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import { SqlClient } from "effect/unstable/sql";

import { makePromptSuggestions } from "./promptSuggestions.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProviderInstance } from "./provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "./provider/Services/ProviderInstanceRegistry.ts";
import { ServerSettingsService } from "./serverSettings.ts";
import type { PromptSuggestionGenerationInput } from "./textGeneration/TextGeneration.ts";

const threadId = ThreadId.make("thread");
const turnId = TurnId.make("turn");
const instanceId = ProviderInstanceId.make("codex_work");
const input = { threadId, turnId };
const expected = { suggestion: "Add regression coverage for the parser." };

const makeHarness = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const timestamp = DateTime.formatIso(yield* DateTime.now);
  let settings: Settings = {
    ...DEFAULT_SERVER_SETTINGS,
    promptSuggestionsEnabled: true,
    providerInstances: {
      [instanceId]: {
        driver: ProviderDriverKind.make("codex"),
        promptSuggestions: { enabled: true, model: "small", reasoningEffort: "low" },
      },
    },
  };
  let thread: OrchestrationThreadShell = {
    id: threadId,
    projectId: ProjectId.make("project"),
    title: "Parser",
    modelSelection: { instanceId, model: "large" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: {
      turnId,
      state: "completed",
      requestedAt: timestamp,
      startedAt: timestamp,
      completedAt: timestamp,
      assistantMessageId: MessageId.make("assistant"),
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: timestamp,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
  let provider: ServerProvider = {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: timestamp,
    models: [
      {
        slug: "small",
        name: "Small",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Effort",
              type: "select",
              options: [{ id: "low", label: "Low" }],
            },
          ],
        },
      },
    ],
    slashCommands: [],
    skills: [],
  };
  const calls: PromptSuggestionGenerationInput[] = [];
  const requested = yield* Deferred.make<void>();
  const finish = yield* Deferred.make<void>();
  let failure = false;
  let blocked = false;
  const instance = {
    instanceId,
    driverKind: ProviderDriverKind.make("codex"),
    enabled: true,
    snapshot: { getSnapshot: Effect.sync(() => provider) },
    textGeneration: {
      generatePromptSuggestion: (value: PromptSuggestionGenerationInput) =>
        Effect.gen(function* () {
          calls.push(value);
          yield* Deferred.succeed(requested, undefined);
          if (blocked) yield* Deferred.await(finish);
          if (failure)
            return yield* Effect.fail(
              new TextGenerationError({
                operation: "generatePromptSuggestion",
                detail: "rate limited",
              }),
            );
          return expected;
        }),
    },
  } as ProviderInstance;
  yield* sql`INSERT INTO projection_thread_messages
    (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
    VALUES ('user', ${threadId}, ${turnId}, 'user', ${"u".repeat(5000)}, 0, ${timestamp}, ${timestamp}),
      ('assistant', ${threadId}, ${turnId}, 'assistant', ${"a".repeat(9000)}, 0, ${timestamp}, ${timestamp})`;
  yield* sql`INSERT INTO projection_turns
    (thread_id, turn_id, pending_message_id, assistant_message_id, state, requested_at, started_at, completed_at, checkpoint_files_json)
    VALUES (${threadId}, ${turnId}, 'user', 'assistant', 'completed', ${timestamp}, ${timestamp}, ${timestamp}, '[]')`;
  const get = yield* makePromptSuggestions.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ServerSettingsService)({ getSettings: Effect.sync(() => settings) }),
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadShellById: () => Effect.sync(() => Option.some(thread)),
          getProjectShellById: () =>
            Effect.succeed(
              Option.some({
                id: thread.projectId,
                title: "Project",
                workspaceRoot: "/work",
                scripts: [],
                createdAt: timestamp,
                updatedAt: timestamp,
                repositoryIdentity: null,
                defaultModelSelection: null,
              }),
            ),
        }),
        Layer.mock(ProviderInstanceRegistry)({
          getInstance: (id) => Effect.succeed(id === instanceId ? instance : undefined),
        }),
      ),
    ),
  );
  return {
    get,
    calls,
    requested,
    finish,
    sql,
    block: () => {
      blocked = true;
    },
    fail: () => {
      failure = true;
    },
    settings: (patch: Partial<Settings>) => {
      settings = { ...settings, ...patch };
    },
    thread: (patch: Partial<OrchestrationThreadShell>) => {
      thread = { ...thread, ...patch };
    },
    provider: (patch: Partial<ServerProvider>) => {
      provider = { ...provider, ...patch };
    },
  };
});

function testHarness<A, E>(
  run: (
    h: Effect.Success<typeof makeHarness>,
  ) => Effect.Effect<A, E, Scope.Scope | SqlClient.SqlClient>,
) {
  return makeHarness.pipe(
    Effect.flatMap(run),
    Effect.scoped,
    Effect.provide(SqlitePersistenceMemory),
  );
}

it.effect(
  "shares concurrent generation across clients and uses the exact instance's bounded context",
  () =>
    testHarness((h) =>
      Effect.gen(function* () {
        h.block();
        const first = yield* h.get(input).pipe(Effect.forkChild);
        yield* Deferred.await(h.requested);
        const second = yield* h.get(input).pipe(Effect.forkChild);
        yield* Deferred.succeed(h.finish, undefined);
        assert.deepStrictEqual(yield* Fiber.join(first), expected);
        assert.deepStrictEqual(yield* Fiber.join(second), expected);
        assert.deepStrictEqual(yield* h.get(input), expected);
        assert.strictEqual(h.calls.length, 1);
        assert.deepStrictEqual(h.calls[0]?.modelSelection, {
          instanceId,
          model: "small",
          options: [{ id: "reasoningEffort", value: "low" }],
        });
        assert.strictEqual(h.calls[0]?.userMessage.length, 2000);
        assert.strictEqual(h.calls[0]?.assistantMessage.length, 4000);
      }),
    ),
);

it.effect("keeps failures cached without retries or an account fallback", () =>
  testHarness((h) =>
    Effect.gen(function* () {
      h.fail();
      assert.deepStrictEqual(yield* h.get(input), { suggestion: null });
      assert.deepStrictEqual(yield* h.get(input), { suggestion: null });
      assert.strictEqual(h.calls.length, 1);
    }),
  ),
);

it.effect("a disconnected caller does not cancel shared generation or cause another bill", () =>
  testHarness((h) =>
    Effect.gen(function* () {
      h.block();
      const first = yield* h.get(input).pipe(Effect.forkChild);
      yield* Deferred.await(h.requested);
      yield* Fiber.interrupt(first);
      yield* Deferred.succeed(h.finish, undefined);
      assert.deepStrictEqual(yield* h.get(input), expected);
      assert.strictEqual(h.calls.length, 1);
    }),
  ),
);

it.effect("does not generate for old completed turns", () =>
  testHarness((h) =>
    Effect.gen(function* () {
      yield* TestClock.adjust("6 minutes");
      assert.deepStrictEqual(yield* h.get(input), { suggestion: null });
      assert.strictEqual(h.calls.length, 0);
    }),
  ),
);

it.effect("does not deliver a suggestion after another turn starts", () =>
  testHarness((h) =>
    Effect.gen(function* () {
      h.block();
      const request = yield* h.get(input).pipe(Effect.forkChild);
      yield* Deferred.await(h.requested);
      h.thread({ latestTurn: null });
      yield* Deferred.succeed(h.finish, undefined);
      assert.deepStrictEqual(yield* Fiber.join(request), { suggestion: null });
    }),
  ),
);

it.effect("disabling suggestions discards an in-flight result", () =>
  testHarness((h) =>
    Effect.gen(function* () {
      h.block();
      const request = yield* h.get(input).pipe(Effect.forkChild);
      yield* Deferred.await(h.requested);
      h.settings({ promptSuggestionsEnabled: false });
      yield* Deferred.succeed(h.finish, undefined);
      assert.deepStrictEqual(yield* Fiber.join(request), { suggestion: null });
    }),
  ),
);

it.effect(
  "suppresses disabled, unavailable, pending, and stale turns before calling the model",
  () =>
    testHarness((h) =>
      Effect.gen(function* () {
        h.settings({ promptSuggestionsEnabled: false });
        assert.deepStrictEqual(yield* h.get(input), { suggestion: null });
        h.settings({ promptSuggestionsEnabled: true });
        h.thread({ hasPendingUserInput: true });
        assert.deepStrictEqual(yield* h.get(input), { suggestion: null });
        h.thread({ hasPendingUserInput: false, hasPendingApprovals: true });
        assert.deepStrictEqual(yield* h.get(input), { suggestion: null });
        h.thread({ hasPendingApprovals: false });
        h.provider({ models: [] });
        assert.deepStrictEqual(yield* h.get(input), { suggestion: null });
        assert.deepStrictEqual(yield* h.get({ ...input, turnId: TurnId.make("old") }), {
          suggestion: null,
        });
        assert.strictEqual(h.calls.length, 0);
      }),
    ),
);

it.effect("skips queued user messages rather than suggesting a competing next step", () =>
  testHarness((h) =>
    Effect.gen(function* () {
      yield* h.sql`INSERT INTO projection_thread_messages
    (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
    VALUES ('queued', ${threadId}, NULL, 'user', 'Do this next', 0, '9999-01-01T00:00:00Z', '9999-01-01T00:00:00Z')`;
      assert.deepStrictEqual(yield* h.get(input), { suggestion: null });
      assert.strictEqual(h.calls.length, 0);
    }),
  ),
);
