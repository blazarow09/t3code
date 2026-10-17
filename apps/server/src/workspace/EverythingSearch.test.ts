import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ProcessRunner from "../processRunner.ts";
import * as EverythingSearch from "./EverythingSearch.ts";

const cwd = "D:\\work [assets]\\project";
const executable = "C:\\tools\\es.exe";
const output = (stdout: string, code = 0): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: code as ProcessRunner.ProcessRunOutput["code"],
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

function fixture(
  options: {
    paths?: string[];
    ignored?: string[];
    rules?: Record<string, string>;
    repository?: boolean;
    available?: boolean;
    indexed?: boolean;
    malformed?: boolean;
    platform?: NodeJS.Platform;
    enabled?: boolean;
    realPaths?: Record<string, string>;
    nestedRepositories?: string[];
  } = {},
) {
  const reads: string[] = [];
  const run = vi.fn((input: ProcessRunner.ProcessRunInput) => {
    if (input.command === "git") {
      if (input.args.includes("rev-parse"))
        return Effect.succeed(
          output(options.repository ? "true\n" : "", options.repository ? 0 : 128),
        );
      return Effect.succeed(
        output((options.ignored ?? []).join("\0"), options.ignored?.length ? 0 : 1),
      );
    }
    if (options.available === false) return Effect.succeed(output("", 8));
    if (options.malformed) return Effect.succeed(output("not json"));
    const probe = input.args[input.args.indexOf("-n") + 1] === "1";
    return Effect.succeed(
      output(
        JSON.stringify(
          (probe ? (options.indexed === false ? [] : [`${cwd}\\`]) : (options.paths ?? [])).map(
            (filename) => ({ filename }),
          ),
        ),
      ),
    );
  });
  const fs = FileSystem.makeNoop({
    exists: (value) => Effect.succeed(options.nestedRepositories?.includes(value) ?? false),
    realPath: (value) => Effect.succeed(options.realPaths?.[value] ?? value),
    stat: (value) => {
      reads.push(value);
      if (options.rules?.[value] !== undefined)
        return Effect.succeed({
          type: "File",
          size: BigInt(options.rules[value].length),
        } as FileSystem.File.Info);
      return Effect.fail(
        PlatformError.systemError({
          module: "FileSystem",
          method: "stat",
          _tag: "NotFound",
          pathOrDescriptor: value,
        }),
      );
    },
    readFileString: (value) => Effect.succeed(options.rules?.[value] ?? ""),
  });
  return {
    run,
    reads,
    make: EverythingSearch.make.pipe(
      Effect.provideService(HostProcess.Platform, options.platform ?? "win32"),
      Effect.provideService(
        HostProcess.Environment,
        options.enabled === false ? {} : { T3CODE_EVERYTHING_ES: executable },
      ),
      Effect.provideService(ProcessRunner.ProcessRunner, { run }),
      Effect.provideService(FileSystem.FileSystem, fs),
    ),
  };
}

it.effect("stays inactive unless explicitly configured on the Windows host", () =>
  Effect.gen(function* () {
    const disabled = fixture({ enabled: false });
    const linux = fixture({ platform: "linux" });
    expect(yield* (yield* disabled.make).search({ cwd, query: "a", limit: 5 })).toBeUndefined();
    expect(yield* (yield* linux.make).search({ cwd, query: "a", limit: 5 })).toBeUndefined();
    expect(disabled.run).not.toHaveBeenCalled();
    expect(linux.run).not.toHaveBeenCalled();
  }),
);

it.effect("bounds results to the workspace, excludes metadata and ranks exact basenames", () =>
  Effect.gen(function* () {
    const test = fixture({
      paths: [
        `${cwd}\\docs\\Composer.tsx-notes.md`,
        `${cwd}\\src\\Composer.tsx`,
        `${cwd}-other\\Composer.tsx`,
        `E:\\Composer.tsx`,
        `${cwd}\\..\\Composer.tsx`,
        `${cwd}\\.git\\Composer.tsx`,
        `${cwd}\\src\\Composer.tsx`,
      ],
    });
    const result = yield* (yield* test.make).search({ cwd, query: "composer.tsx", limit: 1 });
    expect(result).toEqual({
      entries: [{ path: "src/Composer.tsx", kind: "file" }],
      truncated: true,
    });
    expect(test.reads.every((name) => name.endsWith(".ignore"))).toBe(true);
  }),
);

it.effect("retains fuzzy subsequences, Unicode, directories, and file/image filters", () =>
  Effect.gen(function* () {
    const test = fixture({
      paths: [
        `${cwd}\\src\\components\\`,
        `${cwd}\\src\\Composer.tsx`,
        `${cwd}\\日本語🦊.svg`,
        `${cwd}\\photo.png`,
      ],
    });
    const search = yield* test.make;
    expect(
      (yield* search.search({ cwd, query: "cmp", limit: 8 }))?.entries.map((entry) => entry.path),
    ).toEqual(["src/components", "src/Composer.tsx"]);
    expect(
      (yield* search.search({ cwd, query: "", kind: "directory", limit: 8 }))?.entries,
    ).toEqual([{ path: "src/components", kind: "directory" }]);
    expect(
      (yield* search.search({ cwd, query: "", kind: "directory", imageOnly: true, limit: 1 }))
        ?.entries[0]?.kind,
    ).toBe("file");
    expect((yield* search.search({ cwd, query: "日本語🦊", limit: 8 }))?.entries).toEqual([
      { path: "日本語🦊.svg", kind: "file" },
    ]);
  }),
);

it.effect("treats Everything operators and command switches as literal query characters", () =>
  Effect.gen(function* () {
    const test = fixture();
    yield* (yield* test.make).search({ cwd, query: 'a" | content:secret -exit', limit: 5 });
    const args = test.run.mock.calls[1]![0].args;
    const pattern = args[args.indexOf("-regex") + 1]!;
    expect(pattern).not.toContain('"');
    expect(pattern).not.toContain("content:");
    expect(args).not.toContain("-exit");
    expect(pattern).toContain("\\x22");
    expect(pattern).toContain("\\x7c");
    expect(args).toContain("-argv");
  }),
);

it.effect("honors Git ignores, nested .ignore negation and ignored parents", () =>
  Effect.gen(function* () {
    const test = fixture({
      repository: true,
      ignored: ["git-only.txt", "restored.txt"],
      rules: {
        [`${cwd}\\.ignore`]: "*.tmp\nblocked/\n!restored.txt\n",
        [`${cwd}\\src\\.ignore`]: "!keep.tmp\n",
      },
      paths: [
        "git-only.txt",
        "restored.txt",
        "root.tmp",
        "src/keep.tmp",
        "src/drop.tmp",
        "blocked/keep.txt",
        ".env",
      ].map((name) => `${cwd}\\${name.replaceAll("/", "\\")}`),
    });
    const result = yield* (yield* test.make).search({ cwd, query: "", limit: 20 });
    expect(result?.entries.map((entry) => entry.path)).toEqual([
      ".env",
      "restored.txt",
      "src/keep.tmp",
    ]);
    expect(test.reads).not.toContain(`${cwd}\\blocked\\.ignore`);
    expect(
      test.run.mock.calls.find(([input]) => input.args.includes("check-ignore"))?.[0].stdin,
    ).toContain("blocked/\0");
  }),
);

it.effect("skips non-repository caches and hidden paths while retaining FiveM assets", () =>
  Effect.gen(function* () {
    const test = fixture({
      paths: [
        "node_modules/a.ts",
        "venv/a.py",
        "target/debug/a.bin",
        ".cache/a",
        "[vehicles]/car.yft",
      ].map((name) => `${cwd}\\${name.replaceAll("/", "\\")}`),
    });
    expect((yield* (yield* test.make).search({ cwd, query: "", limit: 20 }))?.entries).toEqual([
      { path: "[vehicles]/car.yft", kind: "file" },
    ]);
  }),
);

it.effect("rejects children reached through an external directory junction", () =>
  Effect.gen(function* () {
    const test = fixture({
      paths: [`${cwd}\\external\\secret.txt`],
      realPaths: { [`${cwd}\\external`]: "E:\\private" },
    });
    expect((yield* (yield* test.make).search({ cwd, query: "", limit: 20 }))?.entries).toEqual([]);
  }),
);

it.effect(
  "falls back for an unindexed root instead of reporting an authoritative empty result",
  () =>
    Effect.gen(function* () {
      const test = fixture({ indexed: false });
      expect(yield* (yield* test.make).search({ cwd, query: "", limit: 5 })).toBeUndefined();
      expect(test.run).toHaveBeenCalledTimes(1);
    }),
);

it.effect("backs off after unavailable IPC and retries after the cooldown", () =>
  Effect.gen(function* () {
    const test = fixture({ available: false });
    const service = yield* test.make;
    expect(yield* service.search({ cwd, query: "", limit: 5 })).toBeUndefined();
    expect(yield* service.search({ cwd, query: "other", limit: 5 })).toBeUndefined();
    expect(test.run).toHaveBeenCalledTimes(1);
    yield* TestClock.adjust("30 seconds");
    expect(yield* service.search({ cwd, query: "", limit: 5 })).toBeUndefined();
    expect(test.run).toHaveBeenCalledTimes(2);
  }),
);

it.effect("falls back on malformed output and unsupported shares", () =>
  Effect.gen(function* () {
    const test = fixture({ malformed: true });
    const service = yield* test.make;
    expect(
      yield* service.search({ cwd: "\\\\server\\share", query: "", limit: 5 }),
    ).toBeUndefined();
    expect(test.run).not.toHaveBeenCalled();
    expect(yield* service.search({ cwd, query: "", limit: 5 })).toBeUndefined();
  }),
);

it.effect("uses a nested repository's ignore rules beneath a non-repository workspace", () =>
  Effect.gen(function* () {
    const test = fixture({
      nestedRepositories: [`${cwd}\\resource\\.git`],
      ignored: ["generated/", "generated/a.ts"],
      paths: [`${cwd}\\resource\\generated\\a.ts`, `${cwd}\\resource\\keep.ts`],
    });
    expect((yield* (yield* test.make).search({ cwd, query: "", limit: 10 }))?.entries).toEqual([
      { path: "resource/keep.ts", kind: "file" },
    ]);
    expect(
      test.run.mock.calls.find(([input]) => input.args.includes("check-ignore"))?.[0].cwd,
    ).toBe(`${cwd}\\resource`);
  }),
);

it.effect("honors explicit hidden-file whitelists and re-reads changed ignore rules", () =>
  Effect.gen(function* () {
    const rules = { [`${cwd}\\.ignore`]: "!.env\nsecret.txt\n" };
    const test = fixture({ rules, paths: [`${cwd}\\.env`, `${cwd}\\secret.txt`] });
    const service = yield* test.make;
    expect((yield* service.search({ cwd, query: "", limit: 10 }))?.entries).toEqual([
      { path: ".env", kind: "file" },
    ]);
    rules[`${cwd}\\.ignore`] = "!.env\n";
    expect((yield* service.search({ cwd, query: "", limit: 10 }))?.entries).toHaveLength(2);
  }),
);

it.effect("marks capped candidate pools as incomplete even when filters remove every result", () =>
  Effect.gen(function* () {
    const test = fixture({
      paths: Array.from({ length: 2001 }, (_, index) => `${cwd}\\node_modules\\file${index}.ts`),
    });
    expect(yield* (yield* test.make).search({ cwd, query: "file", limit: 1 })).toEqual({
      entries: [],
      truncated: true,
    });
  }),
);

it.effect("falls back rather than treating oversized ignore files as empty rules", () =>
  Effect.gen(function* () {
    const test = fixture({
      rules: { [`${cwd}\\.ignore`]: "x".repeat(256 * 1024 + 1) },
      paths: [`${cwd}\\a.txt`],
    });
    expect(yield* (yield* test.make).search({ cwd, query: "", limit: 5 })).toBeUndefined();
  }),
);

it.effect("uses native search for a junction workspace root", () =>
  Effect.gen(function* () {
    const test = fixture({ realPaths: { [cwd]: "E:\\actual-project" } });
    expect(yield* (yield* test.make).search({ cwd, query: "", limit: 10 })).toBeUndefined();
    expect(test.run).not.toHaveBeenCalled();
  }),
);

it.effect("interrupts a stalled lookup at the overall deadline", () =>
  Effect.gen(function* () {
    const test = fixture();
    test.run.mockImplementationOnce(() => Effect.never);
    const service = yield* test.make;
    const pending = yield* service.search({ cwd, query: "", limit: 10 }).pipe(Effect.forkChild);
    yield* TestClock.adjust("8 seconds");
    expect(yield* Fiber.join(pending)).toBeUndefined();
  }),
);
