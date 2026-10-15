import {
  createPromptSuggestionCommand,
  createPromptSuggestionLifecycle,
  type PromptSuggestionContext,
} from "@t3tools/client-runtime/prompt-suggestions";
import { useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useAtomCommand } from "../state/use-atom-command";

function subscribeVisibility(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}
function readVisibility() {
  return document.visibilityState === "visible";
}

const command = createPromptSuggestionCommand(connectionAtomRuntime);

export function usePromptSuggestion(input: PromptSuggestionContext) {
  const visible = useSyncExternalStore(subscribeVisibility, readVisibility, () => false);
  const context = visible ? input : null;
  const [lifecycle] = useState(createPromptSuggestionLifecycle);
  useSyncExternalStore(lifecycle.subscribe, lifecycle.getSnapshot, lifecycle.getSnapshot);
  const request = useAtomCommand(command, { reportFailure: false, reportDefect: false });
  useLayoutEffect(() => lifecycle.update(context), [context, lifecycle]);
  useEffect(() => {
    if (!context) return;
    const ticket = lifecycle.begin();
    if (!ticket) return;
    void request({ environmentId: ticket.context.environmentId, input: ticket.context.input }).then(
      (result) => {
        lifecycle.resolve(ticket, result._tag === "Success" ? result.value.suggestion : null);
      },
    );
  }, [context, lifecycle, request]);
  const dismiss = useCallback(() => {
    lifecycle.dismiss();
  }, [lifecycle]);
  return { suggestion: lifecycle.read(context), dismiss };
}
