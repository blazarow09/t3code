import { describe, expect, it } from "vite-plus/test";
import {
  MessageId,
  NodeId,
  ProviderThreadId,
  ProviderTurnId,
  TurnItemId,
} from "@t3tools/contracts";
import { projectedSubagentsToRuntime } from "@t3tools/client-runtime/state/subagentRuntime";

import * as DateTime from "effect/DateTime";
import { ThreadId } from "@t3tools/contracts";
import { enrichSubagentFromProjection, summarizeKnownAgentUsage } from "./AgentsPanel.logic";

const v2Now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const v2ThreadId = ThreadId.make("child-thread");
const v2Projection = {
  visibleTurnItems: [],
  attempts: [],
  nodes: [],
  plans: [],
  providerTurns: [],
  messages: [],
  runs: [],
};
const agent = projectedSubagentsToRuntime([
  {
    id: "child",
    childThreadId: v2ThreadId,
    title: "Child",
    prompt: "Investigate",
    model: "gpt-5",
    status: "completed",
    result: null,
    startedAt: v2Now,
    completedAt: v2Now,
    updatedAt: v2Now,
  },
])[0]!;
const providerTurn = {
  id: ProviderTurnId.make("turn-1"),
  providerThreadId: ProviderThreadId.make("provider-child"),
  nodeId: NodeId.make("node-1"),
  runAttemptId: null,
  nativeTurnRef: null,
  ordinal: 1,
  status: "completed" as const,
  startedAt: v2Now,
  completedAt: v2Now,
  tokenUsage: { usedTokens: 999, inputTokens: 999, updatedAt: "2026-06-20" },
  turnTokenUsage: {
    usageScope: "main_agent" as const,
    usageStatus: "complete" as const,
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 40,
    reasoningTokens: 5,
    hasSubagents: false,
  },
};

describe("agent child detail", () => {
  it("keeps the child identity and uses final usage instead of counting live usage twice", () => {
    expect(agent.childThreadId).toBe(v2ThreadId);
    const detail = enrichSubagentFromProjection(agent, {
      ...v2Projection,
      providerTurns: [providerTurn],
    });
    expect(detail.usage).toMatchObject({
      totalTokens: 120,
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 40,
      reasoningOutputTokens: 5,
    });
  });

  it("includes the child's assistant output while bounding retained transcript rows and text", () => {
    const item = {
      id: TurnItemId.make("reply"),
      threadId: v2ThreadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed" as const,
      title: null,
      startedAt: v2Now,
      completedAt: v2Now,
      updatedAt: v2Now,
      type: "assistant_message" as const,
      messageId: MessageId.make("reply"),
      text: "x".repeat(7000),
      streaming: false,
    };
    const detail = enrichSubagentFromProjection(agent, {
      ...v2Projection,
      visibleTurnItems: Array.from({ length: 120 }, (_, index) => ({
        position: index,
        visibility: "local" as const,
        sourceThreadId: v2ThreadId,
        sourceItemId: TurnItemId.make(`reply-${index}`),
        item: {
          ...item,
          id: TurnItemId.make(`reply-${index}`),
          messageId: MessageId.make(`reply-${index}`),
        },
      })),
    });
    expect(detail.transcript).toHaveLength(100);
    expect(detail.transcript[0]?.summary).toBe("Assistant");
    expect(detail.transcript[0]?.detail).toHaveLength(6000);
  });
  it("distinguishes unavailable metrics from reported zero and sums only known rows", () => {
    expect(summarizeKnownAgentUsage([agent])).toEqual({
      totalTokens: 0,
      knownCount: 0,
      unknownCount: 1,
    });
    expect(summarizeKnownAgentUsage([agent], { [agent.id]: { totalTokens: 0 } })).toEqual({
      totalTokens: 0,
      knownCount: 1,
      unknownCount: 0,
    });
    expect(
      summarizeKnownAgentUsage([agent, { ...agent, id: "other" }], {
        [agent.id]: { totalTokens: 120 },
      }),
    ).toEqual({ totalTokens: 120, knownCount: 1, unknownCount: 1 });
  });
});
