import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import type {
  RuntimeSubagent,
  SubagentTranscriptEntry,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { workEntryViewedImagePath } from "@t3tools/client-runtime/work-log/presentation";
import { deriveTimelineEntriesFromVisibleTurnItems } from "~/session-logic";

/** Detail for one expanded child, from its bounded V2 snapshot window. */
export function enrichSubagentFromProjection(
  agent: RuntimeSubagent,
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "visibleTurnItems" | "attempts" | "nodes" | "plans" | "providerTurns" | "messages" | "runs"
  >,
): RuntimeSubagent {
  const entries = deriveTimelineEntriesFromVisibleTurnItems({
    visibleTurnItems: projection.visibleTurnItems,
    optimisticMessages: [],
    attempts: projection.attempts,
    nodes: projection.nodes,
    plans: projection.plans,
  });
  const transcript: SubagentTranscriptEntry[] = entries
    .slice(-100)
    .flatMap<SubagentTranscriptEntry>((entry) => {
      if (entry.kind === "message")
        return [
          {
            at: entry.createdAt,
            itemId: entry.id,
            summary: entry.message.role === "assistant" ? "Assistant" : "User",
            detail: entry.message.text.slice(0, 6000),
            phase: entry.message.streaming ? ("live" as const) : ("final" as const),
          },
        ];
      if (entry.kind !== "work") return [];
      const imagePath = workEntryViewedImagePath(entry.entry);
      return [
        {
          at: entry.createdAt,
          itemId: entry.id,
          summary: entry.entry.label,
          ...(entry.entry.detail ? { detail: entry.entry.detail.slice(0, 6000) } : {}),
          ...(imagePath ? { imagePath } : {}),
        },
      ];
    });
  const reported = projection.providerTurns.flatMap((turn) => {
    const usage = turn.turnTokenUsage;
    if (usage)
      return [
        {
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          cachedInputTokens: usage.cachedInputTokens ?? 0,
          reasoningTokens: usage.reasoningTokens ?? 0,
        },
      ];
    const live = turn.tokenUsage;
    return live
      ? [
          {
            inputTokens: live.inputTokens ?? 0,
            outputTokens: live.outputTokens ?? 0,
            cachedInputTokens: live.cachedInputTokens ?? 0,
            reasoningTokens: live.reasoningOutputTokens ?? 0,
          },
        ]
      : [];
  });
  const inputTokens = reported.reduce((total, usage) => total + (usage.inputTokens ?? 0), 0);
  const outputTokens = reported.reduce((total, usage) => total + (usage.outputTokens ?? 0), 0);
  const lastReply = projection.messages.findLast(
    (message) => message.role === "assistant" && !message.streaming,
  );
  return {
    ...agent,
    transcript,
    activationCount: Math.max(agent.activationCount, projection.runs.length),
    result: lastReply?.text ?? agent.result,
    usage:
      reported.length > 0
        ? {
            totalTokens: inputTokens + outputTokens,
            inputTokens,
            outputTokens,
            cachedInputTokens: reported.reduce(
              (total, usage) => total + (usage.cachedInputTokens ?? 0),
              0,
            ),
            reasoningOutputTokens: reported.reduce(
              (total, usage) => total + (usage.reasoningTokens ?? 0),
              0,
            ),
            toolUses: entries.filter(
              (entry) => entry.kind === "work" && entry.entry.tone === "tool",
            ).length,
          }
        : agent.usage,
  };
}

/** Unknown metrics stay distinct from known zero without loading closed rows. */
export function summarizeKnownAgentUsage(
  agents: ReadonlyArray<RuntimeSubagent>,
  loaded: Readonly<Record<string, NonNullable<RuntimeSubagent["usage"]>>> = {},
) {
  let totalTokens = 0;
  let knownCount = 0;
  for (const agent of agents) {
    const usage = loaded[agent.id] ?? agent.usage;
    if (!usage) continue;
    knownCount += 1;
    totalTokens += usage.totalTokens;
  }
  return { totalTokens, knownCount, unknownCount: agents.length - knownCount };
}
