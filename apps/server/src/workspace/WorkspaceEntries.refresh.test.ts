import { expect, it } from "@effect/vitest";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as LayerMap from "effect/LayerMap";

import * as EverythingSearch from "./EverythingSearch.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

it.effect("coalesces overlapping refreshes and waits for changes made during the first scan", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const enqueued = yield* Deferred.make<void>();
    let normalized = 0;
    let scans = 0;
    let revision = 1;
    let indexedRevision = 0;
    const index = WorkspaceSearchIndex.WorkspaceSearchIndex.of({
      list: () => Effect.succeed({ entries: [], truncated: false }),
      search: () => Effect.succeed({ entries: [], truncated: false }),
      searchContents: () => Effect.succeed({ matches: [], truncated: false }),
      refresh: () =>
        Effect.gen(function* () {
          scans++;
          const captured = revision;
          if (scans === 1) {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
          }
          indexedRevision = captured;
        }),
    });
    const map = yield* LayerMap.make(
      (_key: string): ReturnType<typeof WorkspaceSearchIndex.layer> =>
        Layer.succeed(WorkspaceSearchIndex.WorkspaceSearchIndex, index),
      { idleTimeToLive: "1 minute" },
    );
    const key = WorkspaceSearchIndex.workspaceSearchIndexKey("/workspace", "paths");
    yield* Effect.void.pipe(Effect.provide(map.get(key)));
    const entries = yield* WorkspaceEntries.make.pipe(
      Effect.provideService(WorkspaceSearchIndex.WorkspaceSearchIndexMap, map),
      Effect.provideService(WorkspacePaths.WorkspacePaths, {
        normalizeWorkspaceRoot: (cwd) =>
          Effect.gen(function* () {
            normalized++;
            if (normalized === 22) yield* Deferred.succeed(enqueued, undefined);
            return cwd;
          }),
        resolveRelativePathWithinRoot: () => Effect.die("not used"),
      }),
      Effect.provideService(EverythingSearch.EverythingSearch, {
        // @effect-diagnostics-next-line effectSucceedWithVoid:off -- Undefined selects the native search fallback.
        search: () => Effect.succeed(undefined),
      }),
      Effect.provideService(VcsProcess.VcsProcess, { run: () => Effect.die("not used") }),
    );
    const first = yield* entries.refresh("/workspace").pipe(Effect.forkChild);
    yield* Deferred.await(started);
    revision = 2;
    const burst = yield* Effect.all(
      Array.from({ length: 20 }, () => entries.refresh("/workspace")),
      { concurrency: "unbounded" },
    ).pipe(Effect.forkChild);
    yield* Deferred.await(enqueued);
    yield* Effect.yieldNow;
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(burst);
    expect(scans).toBe(2);
    expect(indexedRevision).toBe(2);
  }).pipe(Effect.scoped, Effect.provide(NodePath.layer)),
);

it.effect(
  "successful Everything lookup bypasses native index creation for search and legacy listing",
  () =>
    Effect.gen(function* () {
      let nativeCreations = 0;
      const map = yield* LayerMap.make(
        (_key: string): ReturnType<typeof WorkspaceSearchIndex.layer> =>
          Layer.effect(
            WorkspaceSearchIndex.WorkspaceSearchIndex,
            Effect.sync(() => {
              nativeCreations++;
              throw new Error("native index should remain uncreated");
            }),
          ),
        { idleTimeToLive: "1 minute" },
      );
      const result = { entries: [{ path: "car.yft", kind: "file" as const }], truncated: false };
      const entries = yield* WorkspaceEntries.make.pipe(
        Effect.provideService(WorkspaceSearchIndex.WorkspaceSearchIndexMap, map),
        Effect.provideService(WorkspacePaths.WorkspacePaths, {
          normalizeWorkspaceRoot: (cwd) => Effect.succeed(cwd),
          resolveRelativePathWithinRoot: () => Effect.die("not used"),
        }),
        Effect.provideService(EverythingSearch.EverythingSearch, {
          search: () => Effect.succeed(result),
        }),
        Effect.provideService(VcsProcess.VcsProcess, { run: () => Effect.die("not used") }),
      );
      expect(yield* entries.search({ cwd: "/workspace", query: "car", limit: 10 })).toEqual(result);
      expect(yield* entries.list({ cwd: "/workspace" })).toEqual(result);
      yield* entries.refresh("/workspace");
      expect(nativeCreations).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodePath.layer)),
);
