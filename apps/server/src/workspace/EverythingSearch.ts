// @effect-diagnostics nodeBuiltinImport:off
// Everything uses Windows path syntax even in cross-platform adapter tests.
import * as NodePath from "node:path";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import ignore, { type Ignore } from "ignore";

import type {
  ProjectEntry,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isProjectFaviconPath, PROJECT_FAVICON_EXTENSIONS } from "@t3tools/shared/projectFavicon";
import {
  insertRankedSearchResult,
  scoreQueryMatch,
  type RankedSearchResult,
} from "@t3tools/shared/searchRanking";
import * as ProcessRunner from "../processRunner.ts";

const path = NodePath.win32;
const MAX_CANDIDATES = 25_001;
const SEARCH_CANDIDATES = 2_001;
const MAX_IGNORE_BYTES = 256 * 1024;
const RETRY_DELAY_MS = 30_000;
const Rows = Schema.Array(Schema.Struct({ filename: Schema.String }));
const decodeRows = Schema.decodeUnknownEffect(Schema.fromJsonString(Rows));

// Match the native walker's non-repository exclusions without hiding asset folders.
const nonRepositoryIgnores = ignore().add([
  "node_modules/",
  "__pycache__/",
  "venv/",
  ".venv/",
  "**/target/debug/",
  "**/target/release/",
  "**/target/rust-analyzer/",
  "**/target/criterion/",
  "**/go/pkg/mod/",
  "**/.cargo/registry/",
  "**/.rustup/toolchains/",
  "**/.gradle/caches/",
  "**/.m2/repository/",
  "**/.npm/_cacache/",
  ".pub-cache/",
  "**/bin/Debug/",
  "**/bin/Release/",
  "Program Files/",
  "Program Files (x86)/",
  "**/AppData/Local/",
  "**/AppData/Roaming/",
]);

class EverythingUnavailable extends Schema.TaggedError<EverythingUnavailable>()(
  "EverythingUnavailable",
  {
    cause: Schema.optional(Schema.Defect()),
    exitCode: Schema.optional(Schema.Number),
    reason: Schema.Literals([
      "process",
      "output",
      "unindexed-root",
      "ignore-rules",
      "unsupported-path",
      "timeout",
    ]),
  },
) {}

export class EverythingSearch extends Context.Service<
  EverythingSearch,
  {
    /** Undefined means the native index must handle this request. */
    readonly search: (
      input: ProjectSearchEntriesInput,
    ) => Effect.Effect<ProjectSearchEntriesResult | undefined>;
  }
>()("t3/workspace/EverythingSearch") {}

function escapeRegex(value: string): string {
  // Everything parses its own query language after Windows argument decoding.
  // Hex-escape query-language operators as well as regex syntax; never pass user syntax through.
  return Array.from(value, (character) =>
    /[a-zA-Z0-9_-]/u.test(character) || character.codePointAt(0)! > 127
      ? character
      : `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`,
  ).join("");
}

function relativeEntry(cwd: string, filename: string): ProjectEntry | undefined {
  if (!path.isAbsolute(filename)) return;
  const relative = path.relative(cwd, filename).replaceAll("\\", "/");
  if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative))
    return;
  if (relative.split("/").some((part) => part.toLowerCase() === ".git")) return;
  return { path: relative, kind: /[\\/]$/.test(filename) ? "directory" : "file" };
}

function scoreEntry(entry: ProjectEntry, query: string): number | null {
  if (!query) return 0;
  const name = path.basename(entry.path).toLowerCase();
  const nameScore = scoreQueryMatch({
    value: name,
    query,
    exactBase: 0,
    prefixBase: 100,
    boundaryBase: 200,
    includesBase: 300,
    fuzzyBase: 500,
  });
  const pathScore = scoreQueryMatch({
    value: entry.path.toLowerCase(),
    query,
    exactBase: 50,
    prefixBase: 400,
    boundaryBase: 450,
    includesBase: 600,
    fuzzyBase: 800,
  });
  return nameScore === null
    ? pathScore
    : pathScore === null
      ? nameScore
      : Math.min(nameScore, pathScore);
}

export const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const executable = environment.T3CODE_EVERYTHING_ES?.trim();
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const gate = yield* Semaphore.make(2);
  let retryAfter = 0;

  const run = Effect.fn("EverythingSearch.run")(function* (
    command: string,
    args: ReadonlyArray<string>,
    cwd: string,
    stdin?: string,
  ) {
    const result = yield* processRunner
      .run({ command, args, cwd, stdin, timeout: "3 seconds", maxOutputBytes: 8 * 1024 * 1024 })
      .pipe(Effect.mapError((cause) => new EverythingUnavailable({ reason: "process", cause })));
    if (result.timedOut || result.stdoutTruncated || result.stdoutInvalidUtf8) {
      return yield* new EverythingUnavailable({ reason: "output" });
    }
    return result;
  });

  const query = Effect.fn("EverythingSearch.query")(function* (
    cwd: string,
    regex: string,
    count: number,
    kind?: "file" | "directory",
    imageOnly?: boolean,
  ) {
    const args = [
      "-argv",
      "-ipc2",
      "-instance",
      "",
      "-timeout",
      "1000",
      "-json",
      "-columns",
      "full-path",
      "-folder-append-path-separator",
      "-no-header",
      "-no-footer",
      "-no-highlight",
      "-no-pause",
      "-no-case",
      "-no-whole-word",
      "-match-path",
      "-offset",
      "0",
      "-sort",
      "path",
      "-n",
      String(count),
      "-regex",
      regex,
    ];
    if (count > 1) args.push("-path", cwd);
    if (imageOnly || kind === "file") args.push("/a-d");
    else if (kind === "directory") args.push("/ad");
    if (imageOnly)
      args.push(
        `ext:${PROJECT_FAVICON_EXTENSIONS.map((extension) => extension.slice(1)).join(";")}`,
      );
    const result = yield* run(executable!, args, cwd);
    if (result.code !== 0)
      return yield* new EverythingUnavailable({ reason: "process", exitCode: result.code ?? -1 });
    return yield* decodeRows(result.stdout.replace(/^\uFEFF/, "")).pipe(
      Effect.mapError(() => new EverythingUnavailable({ reason: "output" })),
    );
  });

  const filterEntries = Effect.fn("EverythingSearch.filterEntries")(function* (
    cwd: string,
    entries: ReadonlyArray<ProjectEntry>,
  ) {
    const git = yield* run("git", ["rev-parse", "--is-inside-work-tree"], cwd);
    if (git.code !== 0 && git.code !== 128)
      return yield* new EverythingUnavailable({ reason: "ignore-rules" });
    const inRepository = git.code === 0 && git.stdout.trim() === "true";
    // Git check-ignore rejects paths beyond directory symlinks. Prune them before
    // batching, and never read ignore files through junctions outside the workspace.
    const realRoot = yield* fs.realPath(cwd);
    const directoryVisibility = new Map<string, boolean>([["", true]]);
    const repositoryByDirectory = new Map<string, string | undefined>([
      ["", inRepository ? cwd : undefined],
    ]);
    const localEntries: ProjectEntry[] = [];
    for (const entry of entries) {
      if (
        !inRepository &&
        nonRepositoryIgnores.ignores(entry.path + (entry.kind === "directory" ? "/" : ""))
      )
        continue;
      let parent = "";
      let visible = true;
      const directories = entry.path
        .split("/")
        .slice(0, entry.kind === "directory" ? undefined : -1);
      for (const segment of directories) {
        const directory = parent ? parent + "/" + segment : segment;
        let known = directoryVisibility.get(directory);
        if (known === undefined) {
          const resolved = yield* fs.realPath(path.join(cwd, directory)).pipe(
            Effect.catchIf(
              (error) => error.reason._tag === "NotFound",
              () => Effect.void,
            ),
          );
          known =
            resolved !== undefined &&
            resolved.toLowerCase() === path.join(realRoot, directory).toLowerCase();
          directoryVisibility.set(directory, known);
          const nestedRepository = known && (yield* fs.exists(path.join(cwd, directory, ".git")));
          repositoryByDirectory.set(
            directory,
            nestedRepository ? path.join(cwd, directory) : repositoryByDirectory.get(parent),
          );
        }
        if (!known) {
          visible = false;
          break;
        }
        parent = directory;
      }
      if (visible) localEntries.push(entry);
    }
    const allPaths = new Set<string>();
    for (const entry of localEntries) {
      allPaths.add(entry.path + (entry.kind === "directory" ? "/" : ""));
      let parent = NodePath.posix.dirname(entry.path);
      while (parent !== ".") {
        allPaths.add(`${parent}/`);
        parent = NodePath.posix.dirname(parent);
      }
    }
    const gitIgnored = new Set<string>();
    const groups = new Map<string, string[]>();
    for (const candidate of allPaths) {
      const parent = NodePath.posix.dirname(candidate.replace(/\/$/, ""));
      const repository = repositoryByDirectory.get(parent === "." ? "" : parent);
      if (!repository) continue;
      const relative =
        path.relative(repository, path.join(cwd, candidate)).replaceAll("\\", "/") +
        (candidate.endsWith("/") ? "/" : "");
      const group = groups.get(repository) ?? [];
      group.push(relative);
      groups.set(repository, group);
    }
    for (const [repository, paths] of groups) {
      for (let offset = 0; offset < paths.length; offset += 1000) {
        const result = yield* run(
          "git",
          ["-c", "core.fsmonitor=false", "check-ignore", "--no-index", "-z", "--stdin"],
          repository,
          paths.slice(offset, offset + 1000).join("\0") + "\0",
        );
        if (result.code !== 0 && result.code !== 1)
          return yield* new EverythingUnavailable({
            reason: "ignore-rules",
            exitCode: result.code ?? -1,
          });
        for (const ignoredPath of result.stdout.split("\0")) {
          if (!ignoredPath) continue;
          const relative =
            path.relative(cwd, path.join(repository, ignoredPath)).replaceAll("\\", "/") +
            (ignoredPath.endsWith("/") ? "/" : "");
          gitIgnored.add(relative.toLowerCase());
        }
      }
    }

    type Rule = { base: string; matcher: Ignore };
    const rules = new Map<string, Rule | undefined>();
    const readRule = Effect.fnUntraced(function* (directory: string) {
      if (rules.has(directory)) return rules.get(directory);
      const filename = path.join(directory, ".ignore");
      const info = yield* fs.stat(filename).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.void,
        ),
      );
      if (info && (info.type !== "File" || Number(info.size) > MAX_IGNORE_BYTES)) {
        return yield* new EverythingUnavailable({ reason: "ignore-rules" });
      }
      const rule = info
        ? { base: directory, matcher: ignore().add(yield* fs.readFileString(filename)) }
        : undefined;
      rules.set(directory, rule);
      return rule;
    });
    const inherited: Rule[] = [];
    const ancestors: string[] = [];
    let ancestor = path.dirname(cwd);
    while (ancestor !== cwd) {
      ancestors.unshift(ancestor);
      const next = path.dirname(ancestor);
      if (next === ancestor) break;
      ancestor = next;
    }
    for (const directory of ancestors) {
      const rule = yield* readRule(directory);
      if (rule) inherited.push(rule);
    }

    const directoryStates = new Map<string, { visible: boolean; rules: Rule[] }>();
    const rootRule = yield* readRule(cwd);
    directoryStates.set("", {
      visible: true,
      rules: rootRule ? [...inherited, rootRule] : inherited,
    });
    const isIgnored = (entryPath: string, directory: boolean, activeRules: Rule[]) => {
      const candidate = entryPath + (directory ? "/" : "");
      if (!inRepository && nonRepositoryIgnores.ignores(candidate)) return true;
      let ignored =
        gitIgnored.has(candidate.toLowerCase()) ||
        (!inRepository && entryPath.split("/").some((part) => part.startsWith(".")));
      for (const rule of activeRules) {
        const relative = path.relative(rule.base, path.join(cwd, entryPath)).replaceAll("\\", "/");
        const match = rule.matcher.test(relative + (directory ? "/" : ""));
        if (match.ignored) ignored = true;
        else if (match.unignored) ignored = false;
      }
      return ignored;
    };
    const accepted: ProjectEntry[] = [];
    for (const entry of localEntries) {
      const segments = entry.path.split("/");
      let parent = "";
      let state = directoryStates.get("")!;
      for (const segment of segments.slice(0, -1)) {
        const directory = parent ? `${parent}/${segment}` : segment;
        let next = directoryStates.get(directory);
        if (!next) {
          const visible = !isIgnored(directory, true, state.rules);
          const rule = visible ? yield* readRule(path.join(cwd, directory)) : undefined;
          next = { visible, rules: rule ? [...state.rules, rule] : state.rules };
          directoryStates.set(directory, next);
        }
        state = next;
        parent = directory;
        if (!state.visible) break;
      }
      if (state.visible && !isIgnored(entry.path, entry.kind === "directory", state.rules))
        accepted.push(entry);
    }
    return accepted;
  });

  const search: EverythingSearch["Service"]["search"] = Effect.fn("EverythingSearch.search")(
    function* (input) {
      if (
        platform !== "win32" ||
        !executable ||
        !path.isAbsolute(executable) ||
        !/\.exe$/i.test(executable)
      )
        return undefined;
      // Network shares and device namespaces do not have reliable local NTFS index coverage.
      if (!/^[a-z]:[\\/]/i.test(input.cwd) || input.cwd.includes("%") || input.query.length > 512)
        return undefined;
      return yield* gate.withPermits(1)(
        Effect.gen(function* () {
          if ((yield* Clock.currentTimeMillis) < retryAfter) return undefined;
          const cwd = path.normalize(input.cwd).replace(/[\\/]+$/, "");
          if (!/^[a-z]:\\.+/i.test(cwd)) return undefined;
          const realRoot = yield* fs
            .realPath(cwd)
            .pipe(
              Effect.mapError(
                (cause) => new EverythingUnavailable({ reason: "unsupported-path", cause }),
              ),
            );
          if (realRoot.toLowerCase() !== cwd.toLowerCase()) return undefined;
          const rootExpression = escapeRegex(cwd);
          const root = yield* query(cwd, `^${rootExpression}$`, 1);
          if (
            !root.some(
              (row) =>
                path
                  .normalize(row.filename)
                  .replace(/[\\/]+$/, "")
                  .toLowerCase() === cwd.toLowerCase(),
            )
          ) {
            return yield* new EverythingUnavailable({ reason: "unindexed-root" });
          }
          const normalizedQuery = input.query.toLowerCase().replaceAll("\\", "/");
          // Negated character runs avoid the combinatorial backtracking of .*c.*m.*p.
          const fuzzy = Array.from(normalizedQuery, (character) => {
            const literal = character === "/" ? "\\x5c" : escapeRegex(character);
            return "[^" + literal + "]*" + literal;
          }).join("");
          const candidateLimit =
            input.limit > SEARCH_CANDIDATES ? MAX_CANDIDATES : SEARCH_CANDIDATES;
          const rows = yield* query(
            cwd,
            "^" + rootExpression + "\\x5c" + fuzzy + ".*$",
            candidateLimit,
            input.kind,
            input.imageOnly,
          );
          const unique = new Map<string, ProjectEntry>();
          for (const row of rows) {
            const entry = relativeEntry(cwd, row.filename);
            if (
              entry &&
              (!input.kind || input.imageOnly || entry.kind === input.kind) &&
              (!input.imageOnly || (entry.kind === "file" && isProjectFaviconPath(entry.path)))
            )
              unique.set(entry.path.toLowerCase(), entry);
          }
          const ranked: RankedSearchResult<ProjectEntry>[] = [];
          for (const entry of unique.values()) {
            const score = scoreEntry(entry, normalizedQuery);
            if (score === null) continue;
            insertRankedSearchResult(
              ranked,
              { item: entry, score, tieBreaker: entry.path },
              candidateLimit,
            );
          }
          // Filter in ranked batches, stopping once we can answer the requested page.
          // Resolving every matching directory first makes a small picker query pay for thousands of paths.
          const accepted: ProjectEntry[] = [];
          const batchSize = Math.min(1000, Math.max(100, input.limit + 1));
          for (
            let offset = 0;
            offset < ranked.length && accepted.length <= input.limit;
            offset += batchSize
          ) {
            const batch = ranked.slice(offset, offset + batchSize).map(({ item }) => item);
            const visible = yield* filterEntries(cwd, batch).pipe(
              Effect.mapError(
                (cause) => new EverythingUnavailable({ reason: "ignore-rules", cause }),
              ),
            );
            accepted.push(...visible);
          }
          yield* Effect.annotateCurrentSpan({ backend: "everything", candidateCount: rows.length });
          return {
            entries: accepted.slice(0, input.limit),
            truncated: rows.length >= candidateLimit || accepted.length > input.limit,
          };
        }).pipe(
          Effect.timeout(input.limit > SEARCH_CANDIDATES ? "15 seconds" : "8 seconds"),
          Effect.catchTags({
            TimeoutError: (cause) =>
              Effect.fail(new EverythingUnavailable({ reason: "timeout", cause })),
          }),
          Effect.catchTags({
            EverythingUnavailable: Effect.fn("EverythingUnavailable")(function* (error) {
              retryAfter = (yield* Clock.currentTimeMillis) + RETRY_DELAY_MS;
              yield* Effect.logDebug("Everything unavailable; using native workspace search", {
                reason: error.reason,
                exitCode: error.exitCode,
              });
              return undefined;
            }),
          }),
        ),
      );
    },
  );
  return EverythingSearch.of({ search });
});

export const layer = Layer.effect(EverythingSearch, make).pipe(Layer.provide(ProcessRunner.layer));
