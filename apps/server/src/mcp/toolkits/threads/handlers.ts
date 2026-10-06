import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ThreadRelayService from "../../ThreadRelayService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ThreadsToolkit } from "./tools.ts";
export const ThreadsToolkitHandlersLive = ThreadsToolkit.toLayer(
  Effect.map(ThreadRelayService.ThreadRelayService, (service) =>
    ThreadsToolkit.of({
      search_threads: (input) =>
        Effect.flatMap(McpInvocationContext.requireMcpCapability("threads"), () =>
          service.search_threads(input),
        ),
      read_thread: (input) =>
        Effect.flatMap(McpInvocationContext.requireMcpCapability("threads"), () =>
          service.read_thread(input),
        ),
      send_to_thread: (input) =>
        Effect.flatMap(McpInvocationContext.requireMcpCapability("threads"), (scope) =>
          service.send_to_thread(input, scope),
        ),
    }),
  ),
).pipe(Layer.provide(ThreadRelayService.layer));
