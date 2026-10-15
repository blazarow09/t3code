import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import { idleTimeoutMs } from "./android-push-desktop-activity.ts";
import { makeWatchDelivery } from "./android-push-watch-delivery.ts";

const state = (phase: RelayAgentActivityState["phase"], nowMs = 0): RelayAgentActivityState => ({
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  projectTitle: "Project",
  threadTitle: "Task",
  phase,
  headline: "Agent activity",
  modelTitle: "Codex",
  updatedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
  deepLink: "/threads/environment/thread",
});
function setup(initial: { idleMs: number; locked: boolean } | null) {
  let desktop = initial;
  let reads = 0;
  const sent: Array<{ data: Readonly<Record<string, string>>; alert: boolean }> = [];
  const deliver = makeWatchDelivery({
    idleTimeoutMs: 180_000,
    readDesktopActivity: Effect.sync(() => {
      reads++;
      return desktop;
    }),
    send: (data, alert) =>
      Effect.sync(() => {
        sent.push({ data, alert });
      }),
  });
  return {
    sent,
    reads: () => reads,
    setDesktop: (next: typeof desktop) => {
      desktop = next;
    },
    event: (phase: RelayAgentActivityState["phase"], nowMs = 0, replay = false) => {
      const next = state(phase, nowMs);
      return deliver({
        states: new Map([[next.threadId, next]]),
        changedState: replay ? undefined : next,
        nowMs,
        replay,
      });
    },
  };
}

describe("desktop watcher notification policy", () => {
  it.effect(
    "drops completions while active, retains live updates, and never replays the dropped alert",
    () =>
      Effect.gen(function* () {
        const watcher = setup({ idleMs: 179_999, locked: false });
        yield* watcher.event("running");
        yield* watcher.event("completed", 1000);
        expect(watcher.sent.map((message) => message.alert)).toEqual([false, false]);
        expect(watcher.sent[0]?.data.active).toBe("true");
        expect(watcher.sent[1]?.data.active).toBe("false");
        expect(watcher.sent[1]?.data.alert_id).toBeUndefined();
        watcher.setDesktop({ idleMs: 240_000, locked: true });
        yield* watcher.event("completed", 2000);
        yield* watcher.event("completed", 3000, true);
        expect(watcher.sent).toHaveLength(2);
        expect(watcher.reads()).toBe(1);
        yield* watcher.event("running", 4000);
        yield* watcher.event("completed", 5000);
        expect(watcher.sent.at(-1)?.alert).toBe(true);
      }),
  );
  it.effect.each([
    ["the timeout is reached", { idleMs: 180_000, locked: false }],
    ["the PC is locked despite recent input", { idleMs: 0, locked: true }],
    ["activity detection is unavailable", null],
  ] as const)("sends completion alerts when %s", ([_label, desktop]) =>
    Effect.gen(function* () {
      const watcher = setup(desktop);
      yield* watcher.event("running");
      yield* watcher.event("completed", 1000);
      expect(watcher.sent.at(-1)?.alert).toBe(true);
      expect(watcher.sent.at(-1)?.data.alert_title).toBe("Task");
    }),
  );
  it.effect.each(["waiting_for_approval", "waiting_for_input", "failed"] as const)(
    "preserves %s alerts while the desktop is active",
    (phase) =>
      Effect.gen(function* () {
        const watcher = setup({ idleMs: 0, locked: false });
        yield* watcher.event("running");
        yield* watcher.event(phase, 1000);
        expect(watcher.sent.at(-1)?.alert).toBe(true);
        expect(watcher.reads()).toBe(0);
      }),
  );
  it.effect("does not announce historical completions on startup", () =>
    Effect.gen(function* () {
      const watcher = setup({ idleMs: 240_000, locked: true });
      yield* watcher.event("completed", 0, true);
      yield* watcher.event("completed", 1000);
      expect(watcher.sent).toHaveLength(0);
      expect(watcher.reads()).toBe(0);
    }),
  );
  it("defaults to three minutes and accepts an adjustable positive timeout", () => {
    expect(idleTimeoutMs(undefined)).toBe(180_000);
    expect(idleTimeoutMs("5")).toBe(300_000);
    expect(idleTimeoutMs("0.5")).toBe(30_000);
    for (const value of ["", "0", "-1", "NaN", "Infinity", "invalid"])
      expect(() => idleTimeoutMs(value)).toThrow();
  });
});
