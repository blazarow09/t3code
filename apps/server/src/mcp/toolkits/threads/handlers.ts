import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ThreadRelayService from "../../ThreadRelayService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ThreadsToolkit } from "./tools.ts";

export const ThreadsToolkitHandlersLive = McpToolAccess.toLayer(
  ThreadsToolkit,
  Effect.map(ThreadRelayService.ThreadRelayService, (service) => ({
    search_threads: McpToolAccess.reads((input) =>
      Effect.flatMap(McpInvocationContext.requireMcpCapability("threads"), () =>
        service.search_threads(input),
      ),
    ),
    read_thread: McpToolAccess.reads((input) =>
      Effect.flatMap(McpInvocationContext.requireMcpCapability("threads"), () =>
        service.read_thread(input),
      ),
    ),
    send_to_thread: McpToolAccess.writesThreads(
      (input) => [ThreadId.make(input.threadId)],
      (input) =>
        Effect.flatMap(McpInvocationContext.requireMcpCapability("threads"), (scope) =>
          service.send_to_thread(input, scope),
        ),
    ),
  })),
);
