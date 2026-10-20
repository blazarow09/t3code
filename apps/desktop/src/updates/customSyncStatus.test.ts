import { describe, expect, it } from "@effect/vitest";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";

import {
  readCustomSyncConfig,
  parseCustomSyncCommitLog,
  selectCustomSyncBase,
} from "./customSyncStatus.ts";

describe("parseCustomSyncCommitLog", () => {
  it("reads a short sha and subject from each log line", () => {
    expect(
      parseCustomSyncCommitLog("abc1234\tFix the hood crease\ndef5678\tAdd the fender"),
    ).toEqual([
      { sha: "abc1234", subject: "Fix the hood crease" },
      { sha: "def5678", subject: "Add the fender" },
    ]);
  });

  it("ignores blank lines and lines that are not sha-tab-subject", () => {
    expect(parseCustomSyncCommitLog("\nnot a commit\nabc1234\n")).toEqual([]);
  });
});

describe("selectCustomSyncBase", () => {
  const input = {
    builtRevision: "25c84e88c6",
    builtRevisionResolves: true,
  };

  it("counts from the commit the installer was built from", () => {
    expect(selectCustomSyncBase(input)).toBe("25c84e88c6");
  });

  it("reports unknown when the build stamp is missing", () => {
    expect(
      selectCustomSyncBase({
        ...input,
        builtRevision: null,
        builtRevisionResolves: false,
      }),
    ).toBeNull();
  });

  it("reports unknown without installed provenance", () => {
    expect(
      selectCustomSyncBase({
        ...input,
        builtRevision: null,
        builtRevisionResolves: false,
      }),
    ).toBeNull();
  });
});

it("does not substitute a moving branch for a missing installed revision", () => {
  expect(
    selectCustomSyncBase({
      builtRevision: "missing",
      builtRevisionResolves: false,
    }),
  ).toBeNull();
});

it.effect("uses the installed build stamp rather than mutable state or a future build", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-custom-sync-" });
    const state = path.join(root, "state");
    const installed = path.join(root, "installed");
    yield* fs.makeDirectory(state);
    yield* fs.makeDirectory(installed);
    yield* fs.writeFileString(
      path.join(state, "custom-sync.json"),
      JSON.stringify({ repoPath: "repo", builtRevision: "old-state" }),
    );
    yield* fs.writeFileString(
      path.join(installed, "package.json"),
      JSON.stringify({ t3codeCommitHash: "installed-head" }),
    );
    const legacy = yield* readCustomSyncConfig(state, installed);
    expect(Option.getOrThrow(legacy).builtRevision).toBe("installed-head");
    yield* fs.writeFileString(
      path.join(installed, "custom-sync.json"),
      JSON.stringify({ repoPath: "repo", builtRevision: "installed-stamp" }),
    );
    yield* fs.writeFileString(
      path.join(state, "custom-sync.json"),
      JSON.stringify({ repoPath: "repo", builtRevision: "future-build" }),
    );
    expect(Option.getOrThrow(yield* readCustomSyncConfig(state, installed)).builtRevision).toBe(
      "installed-stamp",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
