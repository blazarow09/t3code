import {
  CommandId,
  MessageId,
  type OrchestrationMessage,
  type OrchestrationThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  READ_THREAD_DEFAULT_TURN_LIMIT,
  READ_THREAD_DIGEST_MESSAGE_MAX_CHARS,
  READ_THREAD_DIGEST_TOTAL_MAX_CHARS,
  READ_THREAD_MESSAGE_MAX_CHARS,
  READ_THREAD_TOTAL_MAX_CHARS,
  SEARCH_THREADS_DEFAULT_LIMIT,
  SEARCH_THREADS_MAX_LIMIT,
  SEND_TO_THREAD_MAX_QUEUE,
  type ReadThreadInput,
  type ReadThreadResult,
  type SearchThreadsInput,
  type SearchThreadsResult,
  type SendToThreadInput,
  type SendToThreadResult,
  ThreadNotFoundError,
  ThreadQueueFullError,
  ThreadReadFailedError,
  ThreadSearchFailedError,
  ThreadSendFailedError,
  ThreadSendToSelfError,
  ThreadsToolkit,
} from "./tools.ts";

type TranscriptMessage = ReadThreadResult["transcript"][number];
type SearchEntry = SearchThreadsResult["threads"][number];

/**
 * An instruction waiting for its target thread to finish what it is doing.
 *
 * The queue lives in memory, next to the MCP toolkit layer that owns it, because there is no
 * durable server-side message queue to reuse: dispatching `thread.turn.start` at a thread whose
 * turn is still streaming is a *steer* — the message folds into the running turn instead of
 * starting a new one — so parking has to happen here, above the engine.
 */
interface QueuedInstruction {
  readonly text: string;
}

/** Poll cadence for parked instructions. A parked instruction is not latency-sensitive. */
const QUEUE_POLL_INTERVAL = "2 seconds";
/**
 * After a dispatch, ignore that thread for a while. The read model reaches `starting` a beat
 * after the engine accepts the turn, and dispatching a second instruction inside that window
 * would steer the one just started. Waiting it out keeps every instruction its own turn.
 */
const QUEUE_DISPATCH_COOLDOWN_MS = 10_000;

/** `running` and `starting` mean a turn is in flight; anything else can accept a new one. */
export function isThreadBusy(shell: Pick<OrchestrationThreadShell, "session">): boolean {
  return shell.session?.status === "running" || shell.session?.status === "starting";
}

/** Header fields are one line each, so a title or reason cannot reshape the provenance block. */
function singleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

function transcriptRole(message: OrchestrationMessage): TranscriptMessage["role"] {
  if (message.role === "user") return "user";
  if (message.role === "system") return "system";
  return "assistant";
}

function clampTranscriptMessage(
  text: string,
  perMessage: number,
): { text: string; clamped: boolean } {
  if (text.length <= perMessage) return { text, clamped: false };
  return {
    text: `${text.slice(0, perMessage)}\n…[truncated]`,
    clamped: true,
  };
}

/** Most recent messages win the budget, then the window is restored to chronological order. */
function boundedTranscript(
  messages: ReadonlyArray<OrchestrationMessage>,
  limits: { readonly perMessage: number; readonly total: number },
): {
  transcript: TranscriptMessage[];
  truncated: boolean;
} {
  const usable = messages.filter(
    (message) => message.role !== "reasoning" && message.text.trim().length > 0,
  );
  const kept: TranscriptMessage[] = [];
  let budget = limits.total;
  let truncated = false;
  for (let index = usable.length - 1; index >= 0; index -= 1) {
    const message = usable[index]!;
    const clamped = clampTranscriptMessage(message.text, limits.perMessage);
    if (clamped.clamped) truncated = true;
    if (clamped.text.length > budget) {
      truncated = true;
      if (kept.length === 0) {
        kept.push({
          role: transcriptRole(message),
          text: clamped.text.slice(clamped.text.length - budget),
          createdAt: message.createdAt,
        });
      }
      break;
    }
    budget -= clamped.text.length;
    kept.push({
      role: transcriptRole(message),
      text: clamped.text,
      createdAt: message.createdAt,
    });
  }
  if (kept.length < usable.length) truncated = true;
  return { transcript: kept.toReversed(), truncated };
}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;

  const pending = yield* Ref.make(new Map<ThreadId, ReadonlyArray<QueuedInstruction>>());
  const lastDispatchedAt = yield* Ref.make(new Map<ThreadId, number>());

  const commandId = (tag: string, threadId: ThreadId) =>
    crypto.randomUUIDv4.pipe(
      Effect.orDie,
      Effect.map((uuid) => CommandId.make(`server:${tag}:${threadId}:${uuid}`)),
    );

  const newMessageId = () =>
    crypto.randomUUIDv4.pipe(
      Effect.orDie,
      Effect.map((uuid) => MessageId.make(`mcp_${uuid}`)),
    );

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso), Effect.orDie);

  const readShell = (threadId: ThreadId) =>
    snapshots
      .getThreadShellById(threadId)
      .pipe(Effect.orElseSucceed(() => Option.none<OrchestrationThreadShell>()));

  const dispatchFailure = <E>(
    cause: Cause.Cause<E>,
  ): Effect.Effect<never, ThreadSendFailedError> =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.failCause(cause as Cause.Cause<never>)
      : Effect.fail(new ThreadSendFailedError({ cause }));

  /**
   * Start a real turn in the target thread. Only ever called once the target reads as idle.
   * The thread's own runtime and interaction modes are carried over so a relayed instruction
   * runs under the same permissions its owner configured.
   */
  const dispatchInstruction = (shell: OrchestrationThreadShell, text: string) =>
    Effect.gen(function* () {
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: yield* commandId("mcp-thread-send", shell.id),
        threadId: shell.id,
        message: {
          messageId: yield* newMessageId(),
          role: "user",
          text,
          attachments: [],
        },
        runtimeMode: shell.runtimeMode,
        interactionMode: shell.interactionMode,
        createdAt: yield* nowIso,
      });
      const dispatchedAt = yield* Clock.currentTimeMillis;
      yield* Ref.update(lastDispatchedAt, (current) => {
        const next = new Map(current);
        next.set(shell.id, dispatchedAt);
        return next;
      });
    }).pipe(Effect.catchCause(dispatchFailure));

  /**
   * Move at most one parked instruction for `threadId` into a turn, if the thread is idle and
   * not cooling down. One at a time is deliberate: a second dispatch before the read model
   * shows the first turn would steer it.
   */
  const drainThread = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const queued = (yield* Ref.get(pending)).get(threadId);
      if (queued === undefined || queued.length === 0) return;

      const cooldownUntil = (yield* Ref.get(lastDispatchedAt)).get(threadId) ?? 0;
      const now = yield* Clock.currentTimeMillis;
      if (now - cooldownUntil < QUEUE_DISPATCH_COOLDOWN_MS) return;

      const shell = yield* readShell(threadId);
      if (Option.isNone(shell)) {
        // The target is gone; its parked work can never run.
        yield* Ref.update(pending, (current) => {
          const next = new Map(current);
          next.delete(threadId);
          return next;
        });
        return;
      }
      if (isThreadBusy(shell.value)) return;

      const head = yield* Ref.modify(pending, (current) => {
        const items = current.get(threadId) ?? [];
        const [first, ...rest] = items;
        const next = new Map(current);
        if (first === undefined || rest.length === 0) next.delete(threadId);
        else next.set(threadId, rest);
        return [first, next] as const;
      });
      if (head === undefined) return;
      yield* dispatchInstruction(shell.value, head.text);
    }).pipe(Effect.ignoreCause);

  const drainAll = Effect.gen(function* () {
    const keys = [...(yield* Ref.get(pending)).keys()];
    for (const threadId of keys) {
      yield* drainThread(threadId);
    }
  });

  // Parked instructions would otherwise wait for the next tool call to make progress.
  yield* Effect.gen(function* () {
    yield* drainAll;
    yield* Effect.sleep(QUEUE_POLL_INTERVAL);
  }).pipe(Effect.forever, Effect.forkScoped);

  const requireThread = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const shell = yield* readShell(threadId);
      if (Option.isNone(shell)) {
        return yield* new ThreadNotFoundError({ threadId });
      }
      return shell.value;
    });

  /** Titles make results readable; both lookups are bounded by the caller's result limit. */
  const hydrateSearch = (matches: ReadonlyArray<SearchEntry>) =>
    Effect.gen(function* () {
      const projectTitles = new Map(
        (yield* snapshots.getProjectShells().pipe(Effect.orElseSucceed(() => []))).map(
          (project) => [project.id as string, project.title],
        ),
      );
      const hydrated: SearchEntry[] = [];
      for (const match of matches) {
        const shell = yield* readShell(match.threadId as ThreadId);
        hydrated.push({
          ...match,
          title: Option.isSome(shell) ? shell.value.title : "(deleted thread)",
          projectTitle: projectTitles.get(match.projectId) ?? match.projectId,
        });
      }
      return hydrated;
    });

  return ThreadsToolkit.of({
    search_threads: (input: SearchThreadsInput) =>
      Effect.gen(function* () {
        yield* McpInvocationContext.requireMcpCapability("threads");
        const limit = Math.min(
          input.limit ?? SEARCH_THREADS_DEFAULT_LIMIT,
          SEARCH_THREADS_MAX_LIMIT,
        );
        const result = yield* snapshots
          .searchThreads({ query: input.query, limit })
          // A thread usually matches on several messages; the id is the unit callers act on.
          .pipe(Effect.mapError((cause) => new ThreadSearchFailedError({ cause })));
        const matches: SearchEntry[] = [];
        const seen = new Set<string>();
        const collect = (entry: {
          readonly threadId: string;
          readonly projectId: string;
          readonly snippet: string;
          readonly messageCreatedAt: string | null;
        }) => {
          if (matches.length >= limit || seen.has(entry.threadId)) return;
          seen.add(entry.threadId);
          matches.push({ ...entry, title: "", projectTitle: "" });
        };
        // Titles come first and locally: the projection search only reads message text, so a
        // conversation's own name — usually what a caller has — would never match it.
        const needle = input.query.trim().toLowerCase();
        const shells = yield* snapshots.getShellSnapshot().pipe(
          Effect.map((snapshot) => snapshot.threads),
          Effect.orElseSucceed(() => []),
        );
        for (const shell of shells) {
          if (!shell.title.toLowerCase().includes(needle)) continue;
          collect({
            threadId: shell.id,
            projectId: shell.projectId,
            snippet: shell.title,
            messageCreatedAt: null,
          });
        }
        for (const match of result.matches) {
          collect(match);
        }
        return { threads: yield* hydrateSearch(matches) };
      }),

    read_thread: (input: ReadThreadInput) =>
      Effect.gen(function* () {
        yield* McpInvocationContext.requireMcpCapability("threads");
        const threadId = input.threadId as ThreadId;
        // A digest exists so a relay can look without paying for a transcript.
        const digest = input.detail === "digest";
        // Reading the queue here is free and keeps a parked instruction moving.
        yield* drainThread(threadId);
        const snapshot = yield* snapshots
          .getThreadDetailSnapshot(threadId, {
            turnLimit: digest ? 1 : (input.turnLimit ?? READ_THREAD_DEFAULT_TURN_LIMIT),
          })
          .pipe(Effect.mapError((cause) => new ThreadReadFailedError({ cause })));
        if (Option.isNone(snapshot)) {
          return yield* new ThreadNotFoundError({ threadId: input.threadId });
        }
        const thread = snapshot.value.thread;
        const project = yield* snapshots
          .getProjectShellById(thread.projectId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        const windowed = boundedTranscript(
          thread.messages,
          digest
            ? {
                perMessage: READ_THREAD_DIGEST_MESSAGE_MAX_CHARS,
                total: READ_THREAD_DIGEST_TOTAL_MAX_CHARS,
              }
            : { perMessage: READ_THREAD_MESSAGE_MAX_CHARS, total: READ_THREAD_TOTAL_MAX_CHARS },
        );
        const truncated = windowed.truncated || (snapshot.value.page?.hasMore ?? false);
        return {
          threadId: thread.id,
          title: thread.title,
          projectId: thread.projectId,
          projectTitle: Option.isSome(project) ? project.value.title : thread.projectId,
          status: thread.session?.status ?? null,
          latestTurnState: thread.latestTurn?.state ?? null,
          messageCount: thread.messages.length,
          transcript: windowed.transcript,
          truncated,
          note: digest
            ? 'Digest of the last turn only. Call read_thread again with detail="transcript" if you need what was actually said.'
            : truncated
              ? "Older turns or long messages were dropped to stay within the read budget. Ask the thread's agent if you need the full history."
              : "This is the thread's recent history in full.",
        } satisfies ReadThreadResult;
      }),

    send_to_thread: (input: SendToThreadInput) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.requireMcpCapability("threads");
        const threadId = input.threadId as ThreadId;
        if (threadId === scope.threadId) {
          return yield* new ThreadSendToSelfError({});
        }

        yield* requireThread(threadId);
        const source = yield* readShell(scope.threadId);
        const sourceTitle = singleLine(
          Option.isSome(source) ? source.value.title : "a peer thread",
        );
        const text = [
          "[Instruction relayed from another conversation]",
          `From thread: ${sourceTitle} (threadId ${scope.threadId})`,
          `Context: ${singleLine(
            input.reason ?? "Sent by the agent in that thread at the user's request.",
          )}`,
          "This message arrives with no shared history. Treat it as a standalone task.",
          "",
          "---",
          "",
          input.prompt,
        ].join("\n");

        // Older parked work goes first, so ordering across several sends is preserved.
        yield* drainThread(threadId);

        const refreshed = yield* requireThread(threadId);

        if (!isThreadBusy(refreshed)) {
          yield* dispatchInstruction(refreshed, text);
          return {
            threadId: refreshed.id,
            title: refreshed.title,
            delivery: "sent",
            queuePosition: 0,
            prompt: text,
          } satisfies SendToThreadResult;
        }

        const alreadyQueued = (yield* Ref.get(pending)).get(threadId)?.length ?? 0;
        if (alreadyQueued >= SEND_TO_THREAD_MAX_QUEUE) {
          return yield* new ThreadQueueFullError({ threadId: input.threadId });
        }
        const position = yield* Ref.modify(pending, (current) => {
          const next = new Map(current);
          next.set(threadId, [...(current.get(threadId) ?? []), { text }]);
          return [alreadyQueued + 1, next] as const;
        });

        return {
          threadId: refreshed.id,
          title: refreshed.title,
          delivery: "queued",
          queuePosition: position,
          prompt: text,
        } satisfies SendToThreadResult;
      }),
  });
});

export const ThreadsToolkitHandlersLive = ThreadsToolkit.toLayer(make);
