// @vitest-environment jsdom
import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import type { PromptSuggestionContext } from "@t3tools/client-runtime/prompt-suggestions";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  request: vi.fn(),
}));

vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => harness.request }));
vi.mock("@t3tools/client-runtime/prompt-suggestions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/prompt-suggestions")>()),
  createPromptSuggestionCommand: () => ({}),
}));
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => true }));
vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: () => ({ remove: () => {} }),
  },
}));

import { usePromptSuggestion } from "./use-prompt-suggestion";

let root: Root | null = null;
let container: HTMLDivElement;

function Probe({ context }: { readonly context: PromptSuggestionContext }) {
  const { suggestion } = usePromptSuggestion(context);
  return <div>{suggestion ?? "Chat ready"}</div>;
}

function context(key: string): NonNullable<PromptSuggestionContext> {
  return {
    environmentId: EnvironmentId.make("environment"),
    draftEmpty: true,
    input: { threadId: ThreadId.make(key), runId: RunId.make("run") },
    key,
    turnKey: key,
  };
}

async function render(value: PromptSuggestionContext) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  if (!root) {
    container = document.createElement("div");
    root = createRoot(container);
  }
  await act(async () => root!.render(<Probe context={value} />));
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  harness.request.mockReset();
});

it("keeps a newly opened chat renderable when suggestions are unavailable or fail", async () => {
  await render(null);
  expect(container.textContent).toBe("Chat ready");
  expect(harness.request).not.toHaveBeenCalled();

  harness.request.mockResolvedValue({ _tag: "Failure" });
  await render(context("failed"));
  expect(container.textContent).toBe("Chat ready");

  harness.request.mockResolvedValue({ _tag: "Success", value: { suggestion: null } });
  await render(context("empty"));
  expect(container.textContent).toBe("Chat ready");
});

it("renders a suggestion without repeatedly requesting it on composer rerenders", async () => {
  harness.request.mockResolvedValue({
    _tag: "Success",
    value: { suggestion: "Add a regression test." },
  });
  await render(context("success"));
  expect(container.textContent).toBe("Add a regression test.");
  await render(context("success"));
  expect(harness.request).toHaveBeenCalledTimes(1);
  expect(container.textContent).toBe("Add a regression test.");
  await render({ ...context("success"), draftEmpty: false });
  expect(container.textContent).toBe("Chat ready");
  await render(context("success"));
  expect(container.textContent).toBe("Add a regression test.");
  expect(harness.request).toHaveBeenCalledTimes(1);
});

it("delivers a pending suggestion to a remounted chat", async () => {
  const response = Promise.withResolvers<{
    _tag: "Success";
    value: { suggestion: string };
  }>();
  harness.request.mockReturnValue(response.promise);
  await render(context("remounted-chat"));
  act(() => root!.unmount());
  root = null;
  await render(context("remounted-chat"));
  await act(async () => {
    response.resolve({ _tag: "Success", value: { suggestion: "Verify the result." } });
    await response.promise;
  });
  expect(container.textContent).toBe("Verify the result.");
  expect(harness.request).toHaveBeenCalledTimes(1);
});

it("discards a late suggestion after navigating to another chat", async () => {
  const response = Promise.withResolvers<{
    _tag: "Success";
    value: { suggestion: string };
  }>();
  harness.request.mockReturnValue(response.promise);
  await render(context("old-chat"));
  await render(null);
  await act(async () => {
    response.resolve({ _tag: "Success", value: { suggestion: "Old chat suggestion" } });
    await response.promise;
  });
  expect(container.textContent).toBe("Chat ready");
});
