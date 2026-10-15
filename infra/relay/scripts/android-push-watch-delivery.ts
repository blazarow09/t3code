import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { androidActivityData } from "../src/agentActivity/fcmPayloads.ts";
import { androidAlertForState } from "../src/agentActivity/FcmDeliveries.ts";
import { makeAggregateState } from "../src/agentActivity/agentActivityAggregate.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const preferences = {
  notificationsEnabled: true,
  liveActivitiesEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
};

/** Tracks transitions even when a completion is suppressed, so it cannot be replayed later. */
export function makeWatchDelivery<E>(options: {
  readonly idleTimeoutMs: number;
  readonly readDesktopActivity: Effect.Effect<{
    readonly idleMs: number;
    readonly locked: boolean;
  } | null>;
  readonly send: (data: Readonly<Record<string, string>>, alert: boolean) => Effect.Effect<void, E>;
}) {
  let states = new Map<string, RelayAgentActivityState>();
  let previouslyActive = false;
  return Effect.fnUntraced(function* (input: {
    readonly states: Map<string, RelayAgentActivityState>;
    readonly changedState: RelayAgentActivityState | undefined;
    readonly nowMs: number;
    readonly replay: boolean;
  }) {
    const state = input.changedState;
    const previous = state ? states.get(state.threadId) : undefined;
    let alert =
      state && state.phase !== previous?.phase && !input.replay
        ? androidAlertForState(state, preferences, input.nowMs)
        : null;
    const same = encodeJson([...input.states.values()]) === encodeJson([...states.values()]);
    // Commit the observed transition before consulting desktop activity. Suppression
    // drops the alert; subsequent events and idle/lock changes never re-queue it.
    states = input.states;
    if (alert && state?.phase === "completed") {
      const desktop = yield* options.readDesktopActivity;
      if (
        desktop &&
        !desktop.locked &&
        desktop.idleMs >= 0 &&
        desktop.idleMs < options.idleTimeoutMs
      ) {
        alert = null;
        yield* Effect.logInfo(
          `Completion alert suppressed: desktop active; thread=${state.threadId}`,
        );
      }
    }
    const aggregate = makeAggregateState({
      activeStates: [...states.values()],
      terminalState: null,
      nowMs: input.nowMs,
    });
    const active = (aggregate?.activeCount ?? 0) > 0;
    if ((!active && !previouslyActive && !alert) || (same && !alert)) return;
    yield* options.send(
      { updated_at: String(input.nowMs), ...androidActivityData(aggregate), ...alert },
      alert !== null,
    );
    previouslyActive = active;
    yield* Effect.logInfo(
      `Android push accepted: ${state?.phase ?? (active ? "active" : "ended")}; alert=${alert !== null}; thread=${state?.threadId ?? "aggregate"}`,
    );
  });
}
