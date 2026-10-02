import {
  ORCHESTRATION_WS_METHODS,
  resolveProviderInstanceEnabled,
  type EnvironmentId,
  type OrchestrationThreadShell,
  type ServerSettings,
} from "@t3tools/contracts";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "./connection/registry.ts";
import { createEnvironmentRpcCommand } from "./state/runtime.ts";

export function createPromptSuggestionCommand<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return createEnvironmentRpcCommand(runtime, {
    label: "prompt-suggestion",
    tag: ORCHESTRATION_WS_METHODS.getPromptSuggestion,
  });
}

export function promptSuggestionContext(input: {
  readonly environmentId: EnvironmentId;
  readonly thread:
    | Pick<
        OrchestrationThreadShell,
        | "id"
        | "modelSelection"
        | "latestTurn"
        | "latestUserMessageAt"
        | "session"
        | "hasPendingApprovals"
        | "hasPendingUserInput"
      >
    | null
    | undefined;
  readonly settings: ServerSettings | null | undefined;
  readonly available: boolean;
  readonly draftEmpty: boolean;
  readonly blocked: boolean;
}) {
  const { thread, settings } = input;
  const turn = thread?.latestTurn;
  const provider = thread && settings?.providerInstances[thread.modelSelection.instanceId];
  const config = provider?.promptSuggestions;
  if (
    !input.available ||
    !input.draftEmpty ||
    input.blocked ||
    !settings?.promptSuggestionsEnabled ||
    !provider ||
    !resolveProviderInstanceEnabled(provider) ||
    !config?.enabled ||
    !config.model.trim() ||
    !thread ||
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    turn?.state !== "completed" ||
    turn.completedAt === null ||
    thread.session?.status === "running" ||
    thread.session?.status === "starting" ||
    thread.session?.status === "error" ||
    (thread.latestUserMessageAt !== null &&
      Date.parse(thread.latestUserMessageAt) > Date.parse(turn.completedAt))
  ) {
    return null;
  }
  const turnKey = JSON.stringify([input.environmentId, thread.id, turn.turnId]);
  return {
    environmentId: input.environmentId,
    input: { threadId: thread.id, turnId: turn.turnId },
    turnKey,
    key: JSON.stringify([turnKey, thread.modelSelection.instanceId, config]),
  };
}

export type PromptSuggestionContext = ReturnType<typeof promptSuggestionContext>;

// Composer routes can remount. An attempted turn stays consumed for this client session.
const attemptedTurns = new Set<string>();

/** Owns one visible suggestion and invalidates responses when eligibility changes. */
export function createPromptSuggestionLifecycle(consumedTurns = attemptedTurns) {
  let context: PromptSuggestionContext = null;
  let revision = 0;
  let suggestion: string | null = null;
  let pending = false;
  return {
    update(next: PromptSuggestionContext) {
      if (next?.key === context?.key) return;
      context = next;
      revision += 1;
      suggestion = null;
      pending = false;
    },
    begin() {
      if (!context || consumedTurns.has(context.turnKey)) return null;
      consumedTurns.add(context.turnKey);
      pending = true;
      return { revision, context };
    },
    resolve(ticket: { readonly revision: number }, value: string | null) {
      if (!context || ticket.revision !== revision) return false;
      pending = false;
      suggestion = value?.trim() || null;
      return true;
    },
    read(next: PromptSuggestionContext) {
      return next !== null && next.key === context?.key ? suggestion : null;
    },
    dismiss() {
      if (!pending && suggestion === null) return false;
      revision += 1;
      suggestion = null;
      pending = false;
      return true;
    },
  };
}
