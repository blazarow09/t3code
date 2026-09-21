import { McpCapabilityUnavailableError, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngine.OrchestrationEngineService,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
];

/** Transcript text is clamped per message so one long dump cannot swallow the context window. */
export const READ_THREAD_MESSAGE_MAX_CHARS = 4_000;
/** Total transcript budget for one read, across every message. */
export const READ_THREAD_TOTAL_MAX_CHARS = 48_000;
/**
 * A digest is what a relay needs: enough to know where the thread got to, and nothing more.
 * Reading a full transcript into a thread that is only handing work over is pure cost.
 */
export const READ_THREAD_DIGEST_MESSAGE_MAX_CHARS = 600;
export const READ_THREAD_DIGEST_TOTAL_MAX_CHARS = 1_200;
export const READ_THREAD_DEFAULT_TURN_LIMIT = 12;
export const READ_THREAD_MAX_TURN_LIMIT = 50;
export const SEARCH_THREADS_DEFAULT_LIMIT = 10;
export const SEARCH_THREADS_MAX_LIMIT = 25;
/** Parked sends per thread; beyond this the queue would outlive its usefulness. */
export const SEND_TO_THREAD_MAX_QUEUE = 8;
/** A forwarded instruction is a task, not a briefing: the target thread has its own history. */
export const SEND_TO_THREAD_PROMPT_MAX_CHARS = 4_000;

const ThreadIdInput = TrimmedNonEmptyString.annotate({
  description:
    "Id of the other thread, as returned by search_threads or read from a thread reference.",
});

export const SearchThreadsInput = Schema.Struct({
  query: TrimmedNonEmptyString.annotate({
    description: "Text to match against thread titles and message bodies. At least two characters.",
  }),
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: SEARCH_THREADS_MAX_LIMIT })).annotate({
      description: `Maximum threads to return. Defaults to ${SEARCH_THREADS_DEFAULT_LIMIT}.`,
    }),
  ),
});
export type SearchThreadsInput = typeof SearchThreadsInput.Type;

export const ReadThreadInput = Schema.Struct({
  threadId: ThreadIdInput,
  detail: Schema.optional(
    Schema.Literals(["digest", "transcript"]).annotate({
      description:
        'How much to load. "digest" (default for relaying work) returns the last turn only, clamped to a few hundred characters. "transcript" returns the recent turns in full, for when you must answer about what the thread actually said. Prefer "digest" whenever you are only handing work over.',
    }),
  ),
  turnLimit: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: READ_THREAD_MAX_TURN_LIMIT }),
    ).annotate({
      description: `How many of the most recent turns to include with detail="transcript". Defaults to ${READ_THREAD_DEFAULT_TURN_LIMIT}.`,
    }),
  ),
});
export type ReadThreadInput = typeof ReadThreadInput.Type;

export const SendToThreadInput = Schema.Struct({
  threadId: ThreadIdInput,
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(SEND_TO_THREAD_PROMPT_MAX_CHARS)).annotate(
    {
      description:
        "The focused instruction the other thread should carry out, written for that thread's agent. " +
        `Keep it to the task — a few sentences, at most ${SEND_TO_THREAD_PROMPT_MAX_CHARS} characters, with no restating of ` +
        "that thread's own history, which its agent already has. It arrives with no memory of this conversation.",
    },
  ),
  reason: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "One sentence on why this thread is handing the work over, shown to the other agent as provenance.",
    }),
  ),
});
export type SendToThreadInput = typeof SendToThreadInput.Type;

export class ThreadSearchFailedError extends Schema.TaggedError<ThreadSearchFailedError>()(
  "ThreadSearchFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not search threads.";
  }
}

export class ThreadNotFoundError extends Schema.TaggedError<ThreadNotFoundError>()(
  "ThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found on this server.`;
  }
}

export class ThreadReadFailedError extends Schema.TaggedError<ThreadReadFailedError>()(
  "ThreadReadFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read the thread.";
  }
}

export class ThreadSendToSelfError extends Schema.TaggedError<ThreadSendToSelfError>()(
  "ThreadSendToSelfError",
  {},
) {
  override get message(): string {
    return "send_to_thread cannot target the thread that is already running this turn.";
  }
}

export class ThreadQueueFullError extends Schema.TaggedError<ThreadQueueFullError>()(
  "ThreadQueueFullError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} already has the maximum number of queued instructions waiting.`;
  }
}

export class ThreadSendFailedError extends Schema.TaggedError<ThreadSendFailedError>()(
  "ThreadSendFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not hand the instruction to the other thread.";
  }
}

export const ThreadToolError = Schema.Union([
  McpCapabilityUnavailableError,
  ThreadSearchFailedError,
  ThreadNotFoundError,
  ThreadReadFailedError,
  ThreadSendToSelfError,
  ThreadQueueFullError,
  ThreadSendFailedError,
]);
export type ThreadToolError = typeof ThreadToolError.Type;

export const SearchThreadsResult = Schema.Struct({
  threads: Schema.Array(
    Schema.Struct({
      threadId: Schema.String,
      title: Schema.String,
      projectId: Schema.String,
      projectTitle: Schema.String,
      /** Excerpt of the matching message; not the whole thread. */
      snippet: Schema.String,
      messageCreatedAt: Schema.NullOr(Schema.String),
    }),
  ),
});
export type SearchThreadsResult = typeof SearchThreadsResult.Type;

export const ReadThreadResult = Schema.Struct({
  threadId: Schema.String,
  title: Schema.String,
  projectId: Schema.String,
  projectTitle: Schema.String,
  /** Provider session status: "running" and "starting" mean the thread has a turn in flight. */
  status: Schema.NullOr(Schema.String),
  latestTurnState: Schema.NullOr(Schema.String),
  messageCount: Schema.Int.annotate({
    description: "Messages the thread holds in total, before the window was applied.",
  }),
  transcript: Schema.Array(
    Schema.Struct({
      role: Schema.Literals(["user", "assistant", "system"]),
      text: Schema.String,
      createdAt: Schema.String,
    }),
  ),
  truncated: Schema.Boolean.annotate({
    description: "True when older turns were dropped, or a message was clamped to the read budget.",
  }),
  note: Schema.String,
});
export type ReadThreadResult = typeof ReadThreadResult.Type;

export const SendToThreadResult = Schema.Struct({
  threadId: Schema.String,
  title: Schema.String,
  delivery: Schema.Literals(["sent", "queued"]).annotate({
    description:
      "sent = the other thread was idle and the turn started now. queued = its turn was still running, so the instruction is parked and starts when that turn ends.",
  }),
  queuePosition: Schema.Int.annotate({
    description: "1-based place in that thread's parked queue. 0 when delivery is sent.",
  }),
  prompt: Schema.String.annotate({
    description: "The exact text that was handed to the other thread, provenance header included.",
  }),
});
export type SendToThreadResult = typeof SendToThreadResult.Type;

const SearchThreadsTool = Tool.make("search_threads", {
  description:
    "Search the other conversations on this server by name or by what was said in them. Matches thread titles locally first, then message bodies, and returns thread ids, titles and short snippets — never full transcripts. Use it to find a thread to reference or to hand instructions to.",
  parameters: SearchThreadsInput,
  success: SearchThreadsResult,
  failure: ThreadToolError,
  dependencies,
})
  .annotate(Tool.Title, "Search threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ReadThreadTool = Tool.make("read_thread", {
  description:
    'Read another thread so you can act on it. detail="digest" returns only the last turn, clamped to a few hundred characters — use it whenever you are handing work over or just need to know where that thread got to. detail="transcript" returns the recent turns in full, for when you must answer about what was actually said. Either way the window is partial: read it as a summary, not as the full history, and do not paste it into this conversation.',
  parameters: ReadThreadInput,
  success: ReadThreadResult,
  failure: ThreadToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read thread transcript")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SendToThreadTool = Tool.make("send_to_thread", {
  description:
    "Hand a focused instruction to another conversation on this server, which starts a turn there and keeps both threads working in parallel. Write the prompt for that thread's agent: it sees nothing from this conversation, so make it self-contained, and keep it to the task rather than a briefing — it already has its own history. If that thread already has a turn in flight the instruction is parked and starts when that turn ends, so nothing is interleaved. Keep this conversation's context clean: prefer delegating the read and this send to a subagent when your harness can spawn one, and otherwise read with detail=\"digest\".",
  parameters: SendToThreadInput,
  success: SendToThreadResult,
  failure: ThreadToolError,
  dependencies,
})
  .annotate(Tool.Title, "Send instruction to another thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const ThreadsToolkit = Toolkit.make(SearchThreadsTool, ReadThreadTool, SendToThreadTool);
