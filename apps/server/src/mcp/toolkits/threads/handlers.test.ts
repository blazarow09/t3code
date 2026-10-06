import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Search from "../../../orchestration-v2/ThreadSearch.ts";
import * as Projects from "../../../orchestration-v2/ProjectStore.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import { ThreadsToolkit } from "./tools.ts";
import { ThreadsToolkitHandlersLive } from "./handlers.ts";
const source = ThreadId.make("source");
const target = ThreadId.make("target");
const projectId = ProjectId.make("project");
const instanceId = ProviderInstanceId.make("codex");
const makeHarness = Effect.gen(function* () {
  const now = yield* DateTime.now;
  const sent: Threads.ThreadManagementSendInput[] = [];
  let active = false;
  const shell = {
    id: target,
    projectId,
    title: "Target",
    status: "idle",
    latestRunId: null,
    activeRunId: null,
  } as OrchestrationV2ThreadShell;
  const dependencies = Layer.mergeAll(
    NodeCrypto.layer,
    Layer.succeed(Invocation.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: "test",
      thread: { threadId: source, providerSessionId: "session", providerInstanceId: instanceId },
      client: undefined,
      issuedAt: 0,
      capabilities: new Set(["threads" as const]),
    }),
    Layer.mock(Search.ThreadSearch)({}),
    Layer.mock(Projects.ProjectStoreV2)({
      get: () =>
        Effect.succeed(
          Option.some({
            title: "Project",
          } as import("../../../orchestration-v2/ProjectStore.ts").ProjectRow),
        ),
    }),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.succeed({ ...shell, id, title: id === source ? "Source" : "Target" }),
      getThreadRecords: () =>
        Effect.succeed({ runs: [] }) as unknown as ReturnType<
          Threads.ThreadManagementService["Service"]["getThreadRecords"]
        >,
      sendToThread: (input) => {
        sent.push(input);
        return Effect.succeed({
          delivery: active ? "queued" : "started",
        } as Threads.ThreadManagementSendResult);
      },
      getMessageCount: () => Effect.succeed(3),
      getThreadSnapshotWindow: () =>
        Effect.succeed({
          schemaVersion: 2,
          snapshotSequence: 1,
          projection: {
            messages: [
              { id: "message", role: "assistant", text: "x".repeat(5000), createdAt: now },
            ],
            runs: [],
          } as unknown as import("@t3tools/contracts").OrchestrationV2ThreadProjection,
        }),
    }),
  );
  const toolkit = yield* ThreadsToolkit.pipe(
    Effect.provide(ThreadsToolkitHandlersLive.pipe(Layer.provide(dependencies))),
  );
  return {
    sent,
    setActive: () => {
      active = true;
    },
    send: () =>
      toolkit
        .handle("send_to_thread", { threadId: target, prompt: "Fix the parser" })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies)),
    read: () =>
      toolkit
        .handle("read_thread", { threadId: target, detail: "digest" })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies)),
  };
});
it.effect("starts an idle target through the durable queue path", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    const result = yield* h.send();
    expect(result.at(-1)?.result).toMatchObject({ delivery: "sent", queuePosition: 0 });
    expect(h.sent[0]).toMatchObject({
      mode: "queue",
      senderThreadId: source,
      createdBy: "agent",
      creationSource: "mcp",
    });
    expect(h.sent[0]?.text).toContain("Fix the parser");
  }),
);
it.effect("queues work for an active target without steering it", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    h.setActive();
    const result = yield* h.send();
    expect(result.at(-1)?.result).toMatchObject({ delivery: "queued", queuePosition: 1 });
    expect(h.sent[0]?.mode).toBe("queue");
  }),
);
it.effect("bounds digest content and reports omitted history", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    const result = yield* h.read();
    expect(result.at(-1)?.result).toMatchObject({ truncated: true, messageCount: 3 });
    const value = result.at(-1)?.result;
    expect(value).toHaveProperty("transcript");
    if (value && "transcript" in value) expect(value.transcript[0]?.text.length).toBeLessThan(700);
  }),
);
