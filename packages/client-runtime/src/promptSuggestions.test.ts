import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  RunId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createPromptSuggestionCache,
  createPromptSuggestionLifecycle,
  promptSuggestionContext,
} from "./promptSuggestions.ts";

function fixture() {
  return {
    environmentId: EnvironmentId.make("environment-1"),
    thread: {
      id: ThreadId.make("thread-1"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      latestRun: {
        runId: RunId.make("turn-1"),
        status: "completed" as const,
        requestedAt: "2026-10-01T12:00:00Z",
        startedAt: "2026-10-01T12:00:00Z",
        completedAt: "2026-10-01T12:01:00Z",
        assistantMessageId: null,
      },
      latestUserMessageAt: "2026-10-01T12:00:00Z",
      runtime: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
    },
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      promptSuggestionsEnabled: true,
      providerInstances: {
        codex: {
          driver: "codex",
          config: {},
          promptSuggestions: { enabled: true, model: "gpt-5-mini", reasoningEffort: "low" },
        },
      },
    },
    available: true,
    draftEmpty: true,
    blocked: false,
  };
}

describe("prompt suggestion eligibility", () => {
  it("requires the global preference and an enabled provider configuration", () => {
    const input = fixture();
    expect(promptSuggestionContext(input)).not.toBeNull();
    expect(promptSuggestionContext({ ...input, settings: DEFAULT_SERVER_SETTINGS })).toBeNull();
    input.settings.promptSuggestionsEnabled = false;
    expect(promptSuggestionContext(input)).toBeNull();
    input.settings.promptSuggestionsEnabled = true;
    input.settings.providerInstances.codex.promptSuggestions.enabled = false;
    expect(promptSuggestionContext(input)).toBeNull();
  });

  it.each([{ available: false }, { blocked: true }])(
    "suppresses requests for an unavailable or occupied composer: %j",
    (override) => {
      expect(promptSuggestionContext({ ...fixture(), ...override })).toBeNull();
    },
  );

  it("does not suggest for a previous turn while a newer user message awaits dispatch", () => {
    const input = fixture();
    input.thread.latestUserMessageAt = "2026-10-01T12:02:00Z";
    expect(promptSuggestionContext(input)).toBeNull();
  });

  it.each(["hasPendingApprovals", "hasPendingUserInput"] as const)(
    "suppresses a raised hand before its detail loads: %s",
    (key) => {
      const input = fixture();
      input.thread[key] = true;
      expect(promptSuggestionContext(input)).toBeNull();
    },
  );

  it.each(["running", "interrupted", "failed"] as const)(
    "requires a successful completion, not %s",
    (status) => {
      const input = fixture();
      expect(
        promptSuggestionContext({
          ...input,
          thread: { ...input.thread, latestRun: { ...input.thread.latestRun, status } },
        }),
      ).toBeNull();
    },
  );

  it("changes the context when the generation settings change", () => {
    const input = fixture();
    const before = promptSuggestionContext(input);
    input.settings.providerInstances.codex.promptSuggestions.reasoningEffort = "high";
    const after = promptSuggestionContext(input);
    expect(after?.turnKey).toBe(before?.turnKey);
    expect(after?.key).not.toBe(before?.key);
  });
});

describe("prompt suggestion lifecycle", () => {
  it("waits for an empty draft before spending a request, without consuming the turn", () => {
    const lifecycle = createPromptSuggestionLifecycle(createPromptSuggestionCache());
    lifecycle.update(promptSuggestionContext({ ...fixture(), draftEmpty: false }));
    expect(lifecycle.begin()).toBeNull();
    const empty = promptSuggestionContext(fixture());
    lifecycle.update(empty);
    const ticket = lifecycle.begin();
    expect(ticket).not.toBeNull();
    lifecycle.resolve(ticket!, "Verify the result");
    expect(lifecycle.read(empty)).toBe("Verify the result");
  });
  it("restores a suggestion after navigation or a composer remount until accepted", () => {
    const cache = createPromptSuggestionCache();
    const context = promptSuggestionContext(fixture());
    const first = createPromptSuggestionLifecycle(cache);
    first.update(context);
    first.resolve(first.begin()!, "Add focused tests");
    first.update(null);
    expect(first.read(null)).toBeNull();
    first.update(context);
    expect(first.read(context)).toBe("Add focused tests");
    const remounted = createPromptSuggestionLifecycle(cache);
    remounted.update(context);
    expect(remounted.read(context)).toBe("Add focused tests");
    expect(remounted.begin()).toBeNull();
    remounted.dismiss();
    expect(first.read(context)).toBeNull();
  });

  it("does not let an earlier turn overwrite the next turn's suggestion", () => {
    const lifecycle = createPromptSuggestionLifecycle(createPromptSuggestionCache());
    const input = fixture();
    lifecycle.update(promptSuggestionContext(input));
    const earlier = lifecycle.begin()!;
    input.thread.latestRun.runId = RunId.make("next-turn");
    const next = promptSuggestionContext(input);
    lifecycle.update(next);
    lifecycle.resolve(lifecycle.begin()!, "Next suggestion");
    expect(lifecycle.resolve(earlier, "Earlier suggestion")).toBe(false);
    expect(lifecycle.read(next)).toBe("Next suggestion");
  });

  it("consumes a turn once, including across remounts and failed requests", () => {
    const consumed = createPromptSuggestionCache();
    const context = promptSuggestionContext(fixture());
    const lifecycle = createPromptSuggestionLifecycle(consumed);
    lifecycle.update(context);
    const ticket = lifecycle.begin()!;
    expect(lifecycle.begin()).toBeNull();
    lifecycle.resolve(ticket, null);
    const remounted = createPromptSuggestionLifecycle(consumed);
    remounted.update(context);
    expect(remounted.begin()).toBeNull();
  });

  it("retains a late response after typing and restores it when the draft is cleared", async () => {
    const lifecycle = createPromptSuggestionLifecycle(createPromptSuggestionCache());
    const context = promptSuggestionContext(fixture());
    lifecycle.update(context);
    const ticket = lifecycle.begin()!;
    const response = Promise.resolve("Add focused tests");
    const typing = promptSuggestionContext({ ...fixture(), draftEmpty: false });
    lifecycle.update(typing);
    expect(lifecycle.resolve(ticket, await response)).toBe(true);
    expect(lifecycle.read(typing)).toBeNull();
    lifecycle.update(context);
    expect(lifecycle.read(context)).toBe("Add focused tests");
    expect(lifecycle.begin()).toBeNull();
  });

  it.each(["thread", "turn", "environment", "settings"])(
    "ignores a response after a %s change",
    (change) => {
      const lifecycle = createPromptSuggestionLifecycle(createPromptSuggestionCache());
      const input = fixture();
      const oldContext = promptSuggestionContext(input);
      lifecycle.update(oldContext);
      const oldTicket = lifecycle.begin()!;
      if (change === "thread") input.thread.id = ThreadId.make("thread-2");
      if (change === "turn") input.thread.latestRun.runId = RunId.make("turn-2");
      if (change === "environment") input.environmentId = EnvironmentId.make("environment-2");
      if (change === "settings")
        input.settings.providerInstances.codex.promptSuggestions.model = "gpt-5-nano";
      const newContext = promptSuggestionContext(input);
      expect(lifecycle.read(newContext)).toBeNull();
      lifecycle.update(newContext);
      lifecycle.resolve(oldTicket, "Old suggestion");
      expect(lifecycle.read(newContext)).toBeNull();
      if (change !== "settings") {
        const newTicket = lifecycle.begin()!;
        expect(lifecycle.resolve(newTicket, "New suggestion")).toBe(true);
        expect(lifecycle.read(newContext)).toBe("New suggestion");
      } else {
        expect(lifecycle.begin()).toBeNull();
      }
    },
  );

  it("dismisses both pending and visible suggestions without regenerating", () => {
    const lifecycle = createPromptSuggestionLifecycle(createPromptSuggestionCache());
    const input = fixture();
    let context = promptSuggestionContext(input);
    lifecycle.update(context);
    const pendingTicket = lifecycle.begin()!;
    lifecycle.dismiss();
    expect(lifecycle.resolve(pendingTicket, "Ignored")).toBe(false);
    expect(lifecycle.read(context)).toBeNull();
    expect(lifecycle.begin()).toBeNull();
    input.thread.latestRun.runId = RunId.make("turn-2");
    context = promptSuggestionContext(input);
    lifecycle.update(context);
    lifecycle.resolve(lifecycle.begin()!, "Visible");
    expect(lifecycle.read(context)).toBe("Visible");
    lifecycle.dismiss();
    expect(lifecycle.read(context)).toBeNull();
    expect(lifecycle.begin()).toBeNull();
  });
});
