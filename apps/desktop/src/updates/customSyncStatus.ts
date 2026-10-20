import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/**
 * Custom fork support. A branded build ships no update feed, so the stock updater
 * can never tell the user that upstream has moved. Instead the packaging tooling
 * embeds `custom-sync.json` in the installer, naming its checkout and revision.
 * Legacy installs can still read the checkout from the state directory.
 *
 * Stock builds have no such file, which disables the whole path.
 */
export const CUSTOM_SYNC_CONFIG_FILE = "custom-sync.json";

export interface CustomSyncConfig {
  readonly repoPath: string;
  readonly branch: string;
  /** Throwaway branch the installer is built from until finalize moves `branch`. */
  readonly syncBranch: string;
  /**
   * Commit `HEAD` was at when the installer was packaged. The summary counts
   * upstream commits that are not in this revision, so an unfinalized
   * `custom` ref cannot report commits the build already contains.
   */
  readonly builtRevision: string | null;
  readonly upstreamRef: string;
}

export interface CustomSyncCommit {
  readonly sha: string;
  readonly subject: string;
}

export interface CustomSyncProbe {
  readonly behind: number;
  readonly upstreamTip: string | null;
  readonly commits: ReadonlyArray<CustomSyncCommit>;
}

/** Enough of the log to fill the summary the nightly release notes popover shows. */
export const MAX_CUSTOM_SYNC_COMMITS = 12;

/** `git log --pretty=format:%h%x09%s` — one short sha and subject per line. */
export function parseCustomSyncCommitLog(log: string): ReadonlyArray<CustomSyncCommit> {
  const commits: CustomSyncCommit[] = [];
  for (const line of log.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const tab = trimmed.indexOf("\t");
    if (tab <= 0) continue;
    const sha = trimmed.slice(0, tab).trim();
    const subject = trimmed.slice(tab + 1).trim();
    if (sha.length === 0 || subject.length === 0) continue;
    commits.push({ sha, subject });
  }
  return commits;
}

const CustomSyncConfigSchema = Schema.Struct({
  repoPath: Schema.String,
  branch: Schema.optionalKey(Schema.String),
  syncBranch: Schema.optionalKey(Schema.String),
  builtRevision: Schema.optionalKey(Schema.String),
  upstreamRef: Schema.optionalKey(Schema.String),
});

const decodePackagedRevision = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      t3codeCommitHash: Schema.optionalKey(Schema.String),
    }),
  ),
);

const DEFAULT_CUSTOM_SYNC_BRANCH = "custom";
const DEFAULT_CUSTOM_SYNC_WORKING_BRANCH = "custom-sync";

function blankToNull(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The rev the summary compares with upstream.
 *
 * A packaged build is compiled from `builtRevision`. Until finalize, that
 * commit lives on `syncBranch` while `branch` still points at the previous
 * tip, so counting `branch..upstream` reports commits the build already has.
 */
export function selectCustomSyncBase(input: {
  readonly builtRevision: string | null;
  readonly builtRevisionResolves: boolean;
}): string | null {
  if (input.builtRevision !== null) return input.builtRevisionResolves ? input.builtRevision : null;
  return null;
}

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
  appRoot?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const readConfig = (directory: string) =>
    fs.readFileString(path.join(directory, CUSTOM_SYNC_CONFIG_FILE)).pipe(
      Effect.orElseSucceed(() => ""),
      Effect.map(decodeCustomSyncDocument),
    );
  // The installed artifact owns its baseline; building another installer must not change it.
  const embedded = appRoot === undefined ? Option.none() : yield* readConfig(appRoot);
  const document = Option.isSome(embedded) ? embedded : yield* readConfig(stateDir);
  const envRepoPath = process.env["T3CODE_CUSTOM_SYNC_REPO"]?.trim();
  if (Option.isNone(document) && !envRepoPath) return Option.none<CustomSyncConfig>();
  const config = Option.getOrUndefined(document);
  let builtRevision = blankToNull(config?.builtRevision);
  if (Option.isNone(embedded) && appRoot !== undefined) {
    const metadata = yield* fs.readFileString(path.join(appRoot, "package.json")).pipe(
      Effect.orElseSucceed(() => ""),
      Effect.map(decodePackagedRevision),
    );
    if (Option.isSome(metadata))
      builtRevision = blankToNull(metadata.value.t3codeCommitHash) ?? builtRevision;
  }
  return Option.some<CustomSyncConfig>({
    repoPath: envRepoPath || config?.repoPath || "",
    branch: config?.branch?.trim() || DEFAULT_CUSTOM_SYNC_BRANCH,
    syncBranch: config?.syncBranch?.trim() || DEFAULT_CUSTOM_SYNC_WORKING_BRANCH,
    builtRevision,
    upstreamRef: config?.upstreamRef?.trim() || "upstream/main",
  });
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

  const resolves = (rev: string) =>
    git(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]).pipe(
      Effect.map((output) => output.trim().length > 0),
      Effect.orElseSucceed(() => false),
    );
  const base = selectCustomSyncBase({
    builtRevision: config.builtRevision,
    builtRevisionResolves: config.builtRevision !== null && (yield* resolves(config.builtRevision)),
  });
  if (base === null) return Option.none<CustomSyncProbe>();
  const range = `${base}..${config.upstreamRef}`;
  const counted = yield* git(["rev-list", "--count", range]);
  const behind = Number.parseInt(counted.trim(), 10);
  if (!Number.isInteger(behind) || behind < 0) {
    return Option.none<CustomSyncProbe>();
  }

  const upstreamTip = yield* git(["rev-parse", "--short", config.upstreamRef]);
  const log =
    behind === 0
      ? ""
      : yield* git([
          "log",
          "--pretty=format:%h%x09%s",
          "-n",
          String(MAX_CUSTOM_SYNC_COMMITS),
          range,
        ]);

  return Option.some<CustomSyncProbe>({
    behind,
    upstreamTip: upstreamTip.trim() || null,
    commits: parseCustomSyncCommitLog(log),
  });
});
