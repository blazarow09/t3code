import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/**
 * Custom fork support. A branded build ships no update feed, so the stock updater
 * can never tell the user that upstream has moved. Instead the packaging tooling
 * (`t3code-custom-sync`, `-Phase build`) drops a small `custom-sync.json` into
 * the state directory naming the checkout this build came from, and the app asks
 * that checkout directly.
 *
 * Stock builds have no such file, which disables the whole path.
 */
export const CUSTOM_SYNC_CONFIG_FILE = "custom-sync.json";

export interface CustomSyncConfig {
  readonly repoPath: string;
  readonly branch: string;
  readonly upstreamRef: string;
}

export interface CustomSyncProbe {
  readonly behind: number;
  readonly upstreamTip: string | null;
}

const CustomSyncConfigSchema = Schema.Struct({
  repoPath: Schema.String,
  branch: Schema.optionalKey(Schema.String),
  upstreamRef: Schema.optionalKey(Schema.String),
});

const decodeCustomSyncDocument = Schema.decodeUnknownOption(
  Schema.fromJsonString(CustomSyncConfigSchema),
);

/**
 * Resolves which checkout to inspect. `T3CODE_CUSTOM_SYNC_REPO` wins so a build
 * can be pointed at a different clone without rewriting the file. A missing or
 * malformed file resolves to `none` rather than an error.
 */
export const readCustomSyncConfig = Effect.fn("desktop.customSync.readConfig")(function* (
  stateDir: string,
) {
  const envRepoPath = process.env["T3CODE_CUSTOM_SYNC_REPO"]?.trim();
  if (envRepoPath) {
    return Option.some<CustomSyncConfig>({
      repoPath: envRepoPath,
      branch: "custom",
      upstreamRef: "upstream/main",
    });
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const contents = yield* fs
    .readFileString(path.join(stateDir, CUSTOM_SYNC_CONFIG_FILE))
    .pipe(Effect.orElseSucceed(() => ""));

  return Option.map(decodeCustomSyncDocument(contents), (config) => ({
    repoPath: config.repoPath,
    branch: config.branch?.trim() || "custom",
    upstreamRef: config.upstreamRef?.trim() || "upstream/main",
  }));
});

/**
 * Fetches upstream and counts the commits this build is missing. Callers absorb
 * the platform failure, so being offline or missing git reads as "no signal".
 */
export const probeCustomSync = Effect.fn("desktop.customSync.probe")(function* (
  config: CustomSyncConfig,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const git = (args: ReadonlyArray<string>) =>
    spawner.string(
      ChildProcess.make("git", ["-C", config.repoPath, ...args], {
        stdin: "ignore",
        stderr: "ignore",
      }),
    );

  yield* git(["fetch", "--quiet", "upstream"]);

  const counted = yield* git(["rev-list", "--count", `${config.branch}..${config.upstreamRef}`]);
  const behind = Number.parseInt(counted.trim(), 10);
  if (!Number.isInteger(behind) || behind < 0) {
    return Option.none<CustomSyncProbe>();
  }

  const upstreamTip = yield* git(["rev-parse", "--short", config.upstreamRef]);

  return Option.some<CustomSyncProbe>({
    behind,
    upstreamTip: upstreamTip.trim() || null,
  });
});
