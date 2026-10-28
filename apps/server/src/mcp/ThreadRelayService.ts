import {
  CommandId,
  MessageId,
  ThreadId,
  type OrchestrationV2ConversationMessage as OrchestrationMessage,
  type OrchestrationV2ThreadShell as OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
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
  type SearchThreadsInput,
  type SendToThreadInput,
  type ReadThreadResult,
  type SearchThreadsResult,
  type SendToThreadResult,
  ThreadNotFoundError,
  ThreadQueueFullError,
  ThreadReadFailedError,
  ThreadSearchFailedError,
  ThreadSendFailedError,
  ThreadSendToSelfError,
} from "./toolkits/threads/tools.ts";
type TranscriptMessage = ReadThreadResult["transcript"][number];
type SearchEntry = SearchThreadsResult["threads"][number];
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
  const usable = messages.filter((message) => message.text.trim().length > 0);
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
          createdAt: DateTime.formatIso(message.createdAt),
        });
      }
      break;
    }
    budget -= clamped.text.length;
    kept.push({
      role: transcriptRole(message),
      text: clamped.text,
      createdAt: DateTime.formatIso(message.createdAt),
    });
  }
  if (kept.length < usable.length) truncated = true;
  return { transcript: kept.toReversed(), truncated };
}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const search = yield* ThreadSearch.ThreadSearch;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const crypto = yield* Crypto.Crypto;
  const requireThread = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(
      Effect.mapError((cause) => new ThreadReadFailedError({ cause })),
      Effect.filterOrFail(
        (shell) => shell !== null,
        () => new ThreadNotFoundError({ threadId }),
      ),
    );
  return {
    search_threads: Effect.fn("search_threads")(function* (input: SearchThreadsInput) {
      const limit = Math.min(input.limit ?? SEARCH_THREADS_DEFAULT_LIMIT, SEARCH_THREADS_MAX_LIMIT);
      const result = yield* search
        .search({ query: input.query, limit })
        .pipe(Effect.mapError((cause) => new ThreadSearchFailedError({ cause })));
      const snapshot = yield* threads
        .getShellSnapshot()
        .pipe(Effect.mapError((cause) => new ThreadSearchFailedError({ cause })));
      const projectTitles = new Map(
        (yield* projects.list().pipe(Effect.orElseSucceed(() => []))).map((project) => [
          project.projectId,
          project.title,
        ]),
      );
      const matches: SearchEntry[] = [];
      const seen = new Set<string>();
      const add = (
        id: ThreadId,
        projectId: OrchestrationThreadShell["projectId"],
        snippet: string,
        messageCreatedAt: string | null,
      ) => {
        if (seen.has(id) || matches.length >= limit) return;
        const shell = snapshot.threads.find((thread) => thread.id === id);
        if (!shell) return;
        seen.add(id);
        matches.push({
          threadId: id,
          projectId,
          title: shell.title,
          projectTitle: projectTitles.get(projectId) ?? projectId,
          snippet,
          messageCreatedAt,
        });
      };
      for (const shell of snapshot.threads)
        if (shell.title.toLowerCase().includes(input.query.trim().toLowerCase()))
          add(shell.id, shell.projectId, shell.title, null);
      for (const match of result.matches)
        add(match.threadId, match.projectId, match.snippet, match.messageCreatedAt);
      return { threads: matches };
    }),
    read_thread: Effect.fn("read_thread")(function* (input: ReadThreadInput) {
      const threadId = ThreadId.make(input.threadId);
      const shell = yield* requireThread(threadId);
      const digest = input.detail === "digest";
      const snapshot = yield* threads
        .getThreadSnapshotWindow(threadId, {
          rowLimit: 200,
          userTurnLimit: digest ? 1 : (input.turnLimit ?? READ_THREAD_DEFAULT_TURN_LIMIT),
        })
        .pipe(Effect.mapError((cause) => new ThreadReadFailedError({ cause })));
      const project = yield* projects
        .get(shell.projectId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      const windowed = boundedTranscript(
        snapshot.projection.messages,
        digest
          ? {
              perMessage: READ_THREAD_DIGEST_MESSAGE_MAX_CHARS,
              total: READ_THREAD_DIGEST_TOTAL_MAX_CHARS,
            }
          : { perMessage: READ_THREAD_MESSAGE_MAX_CHARS, total: READ_THREAD_TOTAL_MAX_CHARS },
      );
      const count = yield* threads
        .getMessageCount(threadId)
        .pipe(Effect.mapError((cause) => new ThreadReadFailedError({ cause })));
      const latestRun = snapshot.projection.runs.find((run) => run.id === shell.latestRunId);
      const truncated = windowed.truncated || count > snapshot.projection.messages.length;
      return {
        threadId,
        title: shell.title,
        projectId: shell.projectId,
        projectTitle: Option.isSome(project) ? project.value.title : shell.projectId,
        status: shell.status,
        latestTurnState: latestRun?.status ?? null,
        messageCount: count,
        transcript: windowed.transcript,
        truncated,
        note: digest
          ? 'Digest of the last turn only. Call read_thread with detail="transcript" for recent history.'
          : truncated
            ? "Older turns or long messages were dropped to stay within the read budget."
            : "This is the recent thread history.",
      } satisfies ReadThreadResult;
    }),
    send_to_thread: Effect.fn("send_to_thread")(function* (
      input: SendToThreadInput,
      scope: McpInvocationContext.McpInvocationScope,
    ) {
      const threadId = ThreadId.make(input.threadId);
      const senderId = scope.thread?.threadId;
      if (threadId === senderId) return yield* new ThreadSendToSelfError({});
      const target = yield* requireThread(threadId);
      const source = senderId
        ? yield* threads.getThreadShell(senderId).pipe(Effect.orElseSucceed(() => null))
        : null;
      const text = [
        "[Instruction relayed from another conversation]",
        "From thread: " +
          singleLine(source?.title ?? scope.client?.label ?? "a peer thread") +
          " (threadId " +
          (senderId ?? "external client") +
          ")",
        "Context: " + singleLine(input.reason ?? "Sent by the agent at the user's request."),
        "This message arrives with no shared history. Treat it as a standalone task.",
        "",
        "---",
        "",
        input.prompt,
      ].join("\n");
      const records = yield* threads
        .getThreadRecords(threadId, ["runs"])
        .pipe(Effect.mapError((cause) => new ThreadSendFailedError({ cause })));
      const queued = records.runs.filter((run) => run.status === "queued").length;
      if (queued >= SEND_TO_THREAD_MAX_QUEUE) return yield* new ThreadQueueFullError({ threadId });
      const uuid = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      const result = yield* threads
        .sendToThread({
          projectId: target.projectId,
          threadId,
          commandId: CommandId.make("mcp-thread-send:" + uuid),
          messageId: MessageId.make("mcp_" + uuid),
          text,
          attachments: [],
          mode: "queue",
          createdBy: "agent",
          creationSource: "mcp",
          ...(senderId ? { senderThreadId: senderId } : {}),
        })
        .pipe(Effect.mapError((cause) => new ThreadSendFailedError({ cause })));
      return {
        threadId,
        title: target.title,
        delivery: result.delivery === "queued" ? "queued" : "sent",
        queuePosition: result.delivery === "queued" ? queued + 1 : 0,
        prompt: text,
      } satisfies SendToThreadResult;
    }),
  };
});
export class ThreadRelayService extends Context.Service<
  ThreadRelayService,
  Effect.Success<typeof make>
>()("t3/mcp/ThreadRelayService") {}
export const layer = Layer.effect(ThreadRelayService, make);
