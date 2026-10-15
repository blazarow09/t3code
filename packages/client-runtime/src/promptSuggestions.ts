import type { EnvironmentThreadShell } from "./state/models.ts";
import {
  ORCHESTRATION_V2_WS_METHODS,
  resolveProviderInstanceEnabled,
  type EnvironmentId,
  type ServerSettings,
} from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "./connection/registry.ts";
import { createEnvironmentRpcCommand } from "./state/runtime.ts";

export function createPromptSuggestionCommand<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return createEnvironmentRpcCommand(runtime, {
    label: "prompt-suggestion",
    tag: ORCHESTRATION_V2_WS_METHODS.getPromptSuggestion,
  });
}

export function promptSuggestionContext(input: {
  readonly environmentId: EnvironmentId;
  readonly thread:
    | Pick<
        EnvironmentThreadShell,
        | "id"
        | "modelSelection"
        | "latestRun"
        | "latestUserMessageAt"
        | "runtime"
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
  const run = thread?.latestRun;
  const provider = thread && settings?.providerInstances[thread.modelSelection.instanceId];
  const config = provider?.promptSuggestions;
  if (
    !input.available ||
    input.blocked ||
    !settings?.promptSuggestionsEnabled ||
    !provider ||
    !resolveProviderInstanceEnabled(provider) ||
    !config?.enabled ||
    !config.model.trim() ||
    !thread ||
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    run?.status !== "completed" ||
    run.completedAt === null ||
    thread.runtime?.status === "running" ||
    thread.runtime?.status === "starting" ||
    thread.runtime?.status === "failed" ||
    (thread.latestUserMessageAt !== null &&
      Date.parse(thread.latestUserMessageAt) > Date.parse(run.completedAt))
  ) {
    return null;
  }
  const turnKey = JSON.stringify([input.environmentId, thread.id, run.runId]);
  return {
    environmentId: input.environmentId,
    draftEmpty: input.draftEmpty,
    input: { threadId: thread.id, runId: run.runId },
    turnKey,
    key: JSON.stringify([turnKey, thread.modelSelection.instanceId, config]),
  };
}

export type PromptSuggestionContext = ReturnType<typeof promptSuggestionContext>;

interface SuggestionEntry {
  readonly turnKey: string;
  readonly key: string;
  suggestion: string | null;
  accepted: boolean;
}

export function createPromptSuggestionCache() {
  return {
    entries: new Map<string, SuggestionEntry>(),
    listeners: new Set<() => void>(),
    revision: 0,
  };
}

// Retain the latest suggestion per chat across composer remounts and navigation.
const suggestions = createPromptSuggestionCache();
const chatKey = (context: NonNullable<PromptSuggestionContext>) =>
  JSON.stringify([context.environmentId, context.input.threadId]);

/** Draft edits and visibility changes hide a suggestion without consuming it. */
export function createPromptSuggestionLifecycle(cache = suggestions) {
  let context: PromptSuggestionContext = null;
  const notify = () => {
    cache.revision += 1;
    for (const listener of cache.listeners) listener();
  };
  return {
    subscribe(listener: () => void) {
      cache.listeners.add(listener);
      return () => {
        cache.listeners.delete(listener);
      };
    },
    getSnapshot: () => cache.revision,
    update(next: PromptSuggestionContext) {
      context = next;
    },
    begin() {
      if (!context?.draftEmpty) return null;
      const id = chatKey(context);
      if (cache.entries.get(id)?.turnKey === context.turnKey) return null;
      const entry: SuggestionEntry = {
        turnKey: context.turnKey,
        key: context.key,
        suggestion: null,
        accepted: false,
      };
      cache.entries.set(id, entry);
      return { id, entry, context };
    },
    resolve(
      ticket: { readonly id: string; readonly entry: SuggestionEntry },
      value: string | null,
    ) {
      if (cache.entries.get(ticket.id) !== ticket.entry || ticket.entry.accepted) return false;
      ticket.entry.suggestion = value?.trim() || null;
      notify();
      return true;
    },
    read(next: PromptSuggestionContext) {
      if (!next?.draftEmpty) return null;
      const entry = cache.entries.get(chatKey(next));
      return entry?.key === next.key && !entry.accepted ? entry.suggestion : null;
    },
    dismiss() {
      if (!context) return false;
      const entry = cache.entries.get(chatKey(context));
      if (!entry || entry.turnKey !== context.turnKey || entry.accepted) return false;
      entry.accepted = true;
      entry.suggestion = null;
      notify();
      return true;
    },
  };
}
