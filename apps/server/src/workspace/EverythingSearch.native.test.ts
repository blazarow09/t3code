import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as References from "effect/References";
import * as Layer from "effect/Layer";
import { FileFinder } from "@ff-labs/fff-node";
import { vi } from "vite-plus/test";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as EverythingSearch from "./EverythingSearch.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

// Opt-in, read-only check against a running local Everything instance. No server or UI is started.
const es = process.env.T3CODE_EVERYTHING_TEST_ES;
const root = process.env.T3CODE_EVERYTHING_TEST_ROOT;
const live = es && root ? it.live : it.live.skip;

live("uses real Everything IPC for filename search without creating a native index", () =>
  Effect.gen(function* () {
    const entries = yield* WorkspaceEntries.WorkspaceEntries;
    const native = vi.spyOn(FileFinder, "create");
    yield* Effect.addFinalizer(() => Effect.sync(() => native.mockRestore()));
    const before = performance.now();
    const found = yield* entries.search({
      cwd: root!,
      query: "WorkspaceEntries.ts",
      kind: "file",
      limit: 10,
    });
    expect(found.entries.some((entry) => entry.path.endsWith("WorkspaceEntries.ts"))).toBe(true);
    yield* entries.refresh(root!);
    const fuzzy = yield* entries.search({
      cwd: root!,
      query: "WrkspcEntr",
      kind: "file",
      limit: 10,
    });
    expect(fuzzy.entries.some((entry) => entry.path.endsWith("WorkspaceEntries.ts"))).toBe(true);
    expect(native).not.toHaveBeenCalled();
    yield* Effect.logInfo("Everything filename smoke", {
      elapsedMs: Math.round(performance.now() - before),
      count: found.entries.length,
    });
  }).pipe(
    Effect.scoped,
    Effect.provideService(References.MinimumLogLevel, "Debug"),
    Effect.provide(
      WorkspaceEntries.layer.pipe(
        Layer.provide(WorkspacePaths.layer),
        Layer.provide(NodeServices.layer),
      ),
    ),
    Effect.provideService(HostProcess.Environment, { ...process.env, T3CODE_EVERYTHING_ES: es }),
  ),
);

live("returns real directory and image matches with bounded results", () =>
  Effect.gen(function* () {
    const search = yield* EverythingSearch.EverythingSearch;
    const directories = yield* search.search({
      cwd: root!,
      query: "workspace",
      kind: "directory",
      limit: 5,
    });
    expect(directories).toBeDefined();
    expect(directories?.entries.length).toBeGreaterThan(0);
    expect(directories?.entries.every((entry) => entry.kind === "directory")).toBe(true);
    const images = yield* search.search({ cwd: root!, query: "", imageOnly: true, limit: 2 });
    expect(images).toBeDefined();
    expect(images!.entries.length).toBeLessThanOrEqual(2);
  }).pipe(
    Effect.scoped,
    Effect.provideService(References.MinimumLogLevel, "Debug"),
    Effect.provide(EverythingSearch.layer.pipe(Layer.provide(NodeServices.layer))),
    Effect.provideService(HostProcess.Environment, { ...process.env, T3CODE_EVERYTHING_ES: es }),
  ),
);

const assetRoot = process.env.T3CODE_EVERYTHING_TEST_ASSET_ROOT;
const assetQuery = process.env.T3CODE_EVERYTHING_TEST_ASSET_QUERY;
const assetLive = es && assetRoot && assetQuery ? it.live : it.live.skip;
assetLive("finds an existing asset by filename without reading its contents", () =>
  Effect.gen(function* () {
    const search = yield* EverythingSearch.EverythingSearch;
    const before = performance.now();
    const result = yield* search.search({
      cwd: assetRoot!,
      query: assetQuery!,
      kind: "file",
      limit: 10,
    });
    expect(result).toBeDefined();
    expect(
      result!.entries.some((entry) => entry.path.toLowerCase().endsWith(assetQuery!.toLowerCase())),
    ).toBe(true);
    yield* Effect.logInfo("Everything asset smoke", {
      elapsedMs: Math.round(performance.now() - before),
      count: result!.entries.length,
    });
  }).pipe(
    Effect.scoped,
    Effect.provideService(References.MinimumLogLevel, "Debug"),
    Effect.provide(EverythingSearch.layer.pipe(Layer.provide(NodeServices.layer))),
    Effect.provideService(HostProcess.Environment, { ...process.env, T3CODE_EVERYTHING_ES: es }),
  ),
);
