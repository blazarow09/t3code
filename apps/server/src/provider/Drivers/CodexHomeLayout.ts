import * as NodeFs from "node:fs";

import { ProviderDriverKind, type CodexSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as PlatformError from "effect/PlatformError";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  holdCodexShadowSqliteSidecar,
  releaseCodexShadowSqliteSidecar,
} from "./CodexShadowSqliteGuard.ts";

export interface CodexHomeLayout {
  readonly mode: "direct" | "authOverlay";
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string | undefined;
  readonly continuationKey: string;
}

const KNOWN_SHARED_DIRECTORIES = [
  "sessions",
  "archived_sessions",
  "sqlite",
  "shell_snapshots",
  "worktrees",
  "skills",
  "plugins",
  "cache",
  "logs",
  "mcp-oauth-locks",
  "thread-writer-locks",
] as const;

// auth.lock guards the shadow home's private auth.json.
const PRIVATE_ENTRY_NAMES = new Set(["auth.json", "auth.lock", "models_cache.json"]);
// Finder maintains metadata separately for each directory, including shadow homes.
const SHADOW_LOCAL_ENTRY_NAMES = new Set(["log", "memories", "tmp", ".DS_Store"]);
// Shadow homes may create local runtime locks first; replace them with shared links because they guard shared state.
const REPLACEABLE_SHARED_RUNTIME_ENTRIES = new Set([
  "mcp-oauth-locks",
  "thread-writer-locks",
  ".sqlite-maintenance.lock",
]);

/**
 * SQLite derives its WAL sidecar paths from the filename it is handed, so a
 * shadow home that shares a database through a symlink still grows real
 * `-shm`/`-wal` files of its own. Codex deletes that path when it closes the
 * database, which removes the sidecar symlink and lets the next launch
 * create a private WAL. On Windows the database file itself is a hardlink,
 * because a symlink copied into Codex's `db-backups` folder still points at
 * the live database. Sidecar symlinks are held open so Codex cannot delete
 * them. Codex can also create the database file itself in the shadow home
 * (`logs_2.sqlite`) when that link is missing. These are shared runtime
 * state, not private account files, so replace them with links to the shared
 * copies.
 */
const REPLACEABLE_SHARED_RUNTIME_ENTRY_PATTERN = /\.(?:db|sqlite)-(?:shm|wal|journal)$/u;
const SHARED_SQLITE_DATABASE_PATTERN = /\.(?:db|sqlite)$/u;
const SQLITE_SIDECAR_SUFFIXES = ["-shm", "-wal", "-journal"] as const;

function isReplaceableSharedRuntimeEntry(entryName: string): boolean {
  return (
    REPLACEABLE_SHARED_RUNTIME_ENTRIES.has(entryName) ||
    REPLACEABLE_SHARED_RUNTIME_ENTRY_PATTERN.test(entryName) ||
    SHARED_SQLITE_DATABASE_PATTERN.test(entryName)
  );
}

function resolveHomePath(path: Path.Path, home: string, value: string | undefined): string {
  const expanded =
    value && value.trim().length > 0 ? expandHomePath(value, home) : path.join(home, ".codex");
  return path.resolve(expanded);
}

export const resolveCodexHomeLayout = Effect.fn("resolveCodexHomeLayout")(function* (
  config: CodexSettings,
): Effect.fn.Return<CodexHomeLayout, never, Path.Path> {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const sharedHomePath = resolveHomePath(path, home, config.homePath);
  const shadowHomePath = config.shadowHomePath.trim();
  if (shadowHomePath.length === 0) {
    return {
      mode: "direct",
      sharedHomePath,
      effectiveHomePath: config.homePath.trim().length > 0 ? sharedHomePath : undefined,
      continuationKey: `codex:home:${sharedHomePath}`,
    };
  }

  const effectiveHomePath = path.resolve(expandHomePath(shadowHomePath, home));
  return {
    mode: "authOverlay",
    sharedHomePath,
    effectiveHomePath,
    // Resume state lives in the shared home. An auth overlay can continue
    // those sessions, so it stays in the same continuation group.
    continuationKey: `codex:home:${sharedHomePath}`,
  };
});

const CodexShadowHomeContext = {
  sharedHomePath: Schema.String,
  effectiveHomePath: Schema.String,
};

export class CodexShadowHomeFileSystemError extends Schema.TaggedError<CodexShadowHomeFileSystemError>()(
  "CodexShadowHomeFileSystemError",
  {
    ...CodexShadowHomeContext,
    operation: Schema.Literals([
      "readLink",
      "makeDirectory",
      "readDirectory",
      "remove",
      "symlink",
      "link",
      "guard",
      "rename",
    ]),
    path: Schema.String,
    targetPath: Schema.optional(Schema.String),
    entryName: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const target = this.targetPath === undefined ? "" : ` to '${this.targetPath}'`;
    return `Codex shadow home filesystem operation '${this.operation}' failed for '${this.path}'${target}.`;
  }
}

export class CodexShadowHomePathConflictError extends Schema.TaggedError<CodexShadowHomePathConflictError>()(
  "CodexShadowHomePathConflictError",
  CodexShadowHomeContext,
) {
  override get message(): string {
    return `Codex shadow home path '${this.effectiveHomePath}' must be different from the shared home path '${this.sharedHomePath}'.`;
  }
}

export class CodexShadowHomeEntryConflictError extends Schema.TaggedError<CodexShadowHomeEntryConflictError>()(
  "CodexShadowHomeEntryConflictError",
  {
    ...CodexShadowHomeContext,
    entryName: Schema.String,
    linkPath: Schema.String,
    targetPath: Schema.String,
  },
) {
  override get message(): string {
    return `Cannot create Codex shadow home entry '${this.entryName}' because '${this.linkPath}' already exists and is not a symlink.`;
  }
}

export class CodexShadowHomePrivateEntrySymlinkError extends Schema.TaggedError<CodexShadowHomePrivateEntrySymlinkError>()(
  "CodexShadowHomePrivateEntrySymlinkError",
  {
    ...CodexShadowHomeContext,
    entryName: Schema.String,
    path: Schema.String,
  },
) {
  override get message(): string {
    return `Codex shadow home private entry '${this.entryName}' at '${this.path}' must be a real file, not a symlink.`;
  }
}

export const CodexShadowHomeError = Schema.Union([
  CodexShadowHomeFileSystemError,
  CodexShadowHomePathConflictError,
  CodexShadowHomeEntryConflictError,
  CodexShadowHomePrivateEntrySymlinkError,
]);
export type CodexShadowHomeError = typeof CodexShadowHomeError.Type;

type LinkState =
  | {
      readonly _tag: "Missing";
    }
  | {
      readonly _tag: "NotSymlink";
    }
  | {
      readonly _tag: "Symlink";
      readonly target: string;
    };

function isNotSymlinkError(error: PlatformError.PlatformError): boolean {
  const cause = error.reason.cause;
  return (
    error.reason._tag === "Unknown" &&
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "EINVAL"
  );
}

const readLinkState = Effect.fn("CodexHomeLayout.readLinkState")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
  readonly entryName: string;
  readonly linkPath: string;
}): Effect.fn.Return<LinkState, CodexShadowHomeError> {
  return yield* input.fileSystem.readLink(input.linkPath).pipe(
    Effect.map((target): LinkState => ({ _tag: "Symlink", target })),
    Effect.catchTags({
      PlatformError: (cause) => {
        if (cause.reason._tag === "NotFound") {
          return Effect.succeed<LinkState>({ _tag: "Missing" });
        }
        if (isNotSymlinkError(cause)) {
          return Effect.succeed<LinkState>({ _tag: "NotSymlink" });
        }
        return new CodexShadowHomeFileSystemError({
          sharedHomePath: input.sharedHomePath,
          effectiveHomePath: input.effectiveHomePath,
          operation: "readLink",
          path: input.linkPath,
          entryName: input.entryName,
          cause,
        });
      },
    }),
  );
});

const removePrivateSymlink = Effect.fn("CodexHomeLayout.removePrivateSymlink")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
  readonly entryName: string;
}): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const privatePath = path.join(input.effectiveHomePath, input.entryName);
  const state = yield* readLinkState({
    ...input,
    linkPath: privatePath,
  });
  if (state._tag === "Symlink") {
    yield* input.fileSystem.remove(privatePath).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new CodexShadowHomeFileSystemError({
            sharedHomePath: input.sharedHomePath,
            effectiveHomePath: input.effectiveHomePath,
            operation: "remove",
            path: privatePath,
            entryName: input.entryName,
            cause,
          }),
      }),
    );
  }
});

interface SidecarLease {
  readonly paths: string[];
}

function sameDatabaseFile(target: string, link: string): boolean {
  try {
    if (NodeFs.lstatSync(link).isSymbolicLink()) return false;
    const targetStat = NodeFs.statSync(target);
    const linkStat = NodeFs.statSync(link);
    return targetStat.dev === linkStat.dev && targetStat.ino === linkStat.ino;
  } catch {
    return false;
  }
}

const shadowFileSystemError = (input: {
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
  readonly operation: "remove" | "symlink" | "link" | "guard" | "rename";
  readonly path: string;
  readonly targetPath?: string;
  readonly entryName?: string;
  readonly cause: unknown;
}) =>
  new CodexShadowHomeFileSystemError({
    sharedHomePath: input.sharedHomePath,
    effectiveHomePath: input.effectiveHomePath,
    operation: input.operation,
    path: input.path,
    ...(input.targetPath === undefined ? {} : { targetPath: input.targetPath }),
    ...(input.entryName === undefined ? {} : { entryName: input.entryName }),
    cause: input.cause,
  });

const removeShadowEntry = Effect.fn("CodexHomeLayout.removeShadowEntry")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
  readonly entryName: string;
  readonly linkPath: string;
  readonly recursive?: boolean;
}): Effect.fn.Return<void, CodexShadowHomeError> {
  yield* input.fileSystem.remove(input.linkPath, { recursive: input.recursive ?? false }).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        shadowFileSystemError({
          sharedHomePath: input.sharedHomePath,
          effectiveHomePath: input.effectiveHomePath,
          operation: "remove",
          path: input.linkPath,
          entryName: input.entryName,
          cause,
        }),
    }),
  );
});

const protectSidecar = Effect.fn("CodexHomeLayout.protectSidecar")(function* (input: {
  readonly lease: SidecarLease;
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
  readonly entryName: string;
  readonly linkPath: string;
}): Effect.fn.Return<void, CodexShadowHomeError> {
  if (
    process.platform !== "win32" ||
    !REPLACEABLE_SHARED_RUNTIME_ENTRY_PATTERN.test(input.entryName)
  ) {
    return;
  }
  yield* Effect.tryPromise({
    try: () => holdCodexShadowSqliteSidecar(input.linkPath),
    catch: (cause) =>
      shadowFileSystemError({
        sharedHomePath: input.sharedHomePath,
        effectiveHomePath: input.effectiveHomePath,
        operation: "guard",
        path: input.linkPath,
        entryName: input.entryName,
        cause,
      }),
  });
  input.lease.paths.push(input.linkPath);
});

const releaseHeldSidecar = (lease: SidecarLease, linkPath: string) =>
  Effect.promise(async () => {
    const index = lease.paths.lastIndexOf(linkPath);
    if (index < 0) return;
    lease.paths.splice(index, 1);
    await releaseCodexShadowSqliteSidecar(linkPath);
  });

const ensureDatabaseHardlink = Effect.fn("CodexHomeLayout.ensureDatabaseHardlink")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly sharedHomePath: string;
    readonly effectiveHomePath: string;
    readonly entryName: string;
  }): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
    const path = yield* Path.Path;
    const target = path.join(input.sharedHomePath, input.entryName);
    const link = path.join(input.effectiveHomePath, input.entryName);
    const state = yield* readLinkState({
      ...input,
      linkPath: link,
    });
    if (state._tag === "NotSymlink" && sameDatabaseFile(target, link)) return;
    if (state._tag === "NotSymlink" && !isReplaceableSharedRuntimeEntry(input.entryName)) {
      return yield* new CodexShadowHomeEntryConflictError({
        sharedHomePath: input.sharedHomePath,
        effectiveHomePath: input.effectiveHomePath,
        entryName: input.entryName,
        linkPath: link,
        targetPath: target,
      });
    }
    if (state._tag !== "Missing") {
      yield* removeShadowEntry({
        ...input,
        linkPath: link,
        recursive: state._tag === "NotSymlink",
      });
    }
    const hardlinkResult = yield* Effect.try({
      try: (): "linked" | "cross-device" => {
        try {
          NodeFs.linkSync(target, link);
          return "linked";
        } catch (cause) {
          if (
            typeof cause === "object" &&
            cause !== null &&
            "code" in cause &&
            cause.code === "EXDEV"
          ) {
            return "cross-device";
          }
          throw cause;
        }
      },
      catch: (cause) =>
        shadowFileSystemError({
          sharedHomePath: input.sharedHomePath,
          effectiveHomePath: input.effectiveHomePath,
          operation: "link",
          path: link,
          targetPath: target,
          entryName: input.entryName,
          cause,
        }),
    });
    if (hardlinkResult === "cross-device") {
      yield* input.fileSystem.symlink(target, link).pipe(
        Effect.catchTags({
          PlatformError: (cause) =>
            shadowFileSystemError({
              sharedHomePath: input.sharedHomePath,
              effectiveHomePath: input.effectiveHomePath,
              operation: "symlink",
              path: link,
              targetPath: target,
              entryName: input.entryName,
              cause,
            }),
        }),
      );
    }
  },
);

const quarantineShadowDatabaseBackups = Effect.fn(
  "CodexHomeLayout.quarantineShadowDatabaseBackups",
)(function* (input: {
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
}): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const backupRoot = path.join(input.effectiveHomePath, "db-backups");
  yield* Effect.try({
    try: () => {
      let backupStat: NodeFs.Stats;
      try {
        backupStat = NodeFs.lstatSync(backupRoot);
      } catch (cause) {
        if (NodeFs.existsSync(backupRoot)) throw cause;
        return;
      }
      if (backupStat.isSymbolicLink() || !backupStat.isDirectory()) return;
      const dangerous = NodeFs.readdirSync(backupRoot, {
        recursive: true,
        withFileTypes: true,
      }).some(
        (entry) =>
          entry.isSymbolicLink() &&
          (SHARED_SQLITE_DATABASE_PATTERN.test(entry.name) ||
            REPLACEABLE_SHARED_RUNTIME_ENTRY_PATTERN.test(entry.name)),
      );
      if (!dangerous) return;
      NodeFs.renameSync(backupRoot, `${backupRoot}.quarantine-${Date.now()}`);
    },
    catch: (cause) =>
      shadowFileSystemError({
        sharedHomePath: input.sharedHomePath,
        effectiveHomePath: input.effectiveHomePath,
        operation: "rename",
        path: backupRoot,
        entryName: "db-backups",
        cause,
      }),
  });
});

const ensureSymlink = Effect.fn("CodexHomeLayout.ensureSymlink")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
  readonly entryName: string;
  readonly lease: SidecarLease;
}): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const target = path.join(input.sharedHomePath, input.entryName);
  const link = path.join(input.effectiveHomePath, input.entryName);
  if (
    process.platform === "win32" &&
    SHARED_SQLITE_DATABASE_PATTERN.test(input.entryName) &&
    NodeFs.existsSync(target)
  ) {
    return yield* ensureDatabaseHardlink(input);
  }
  const state = yield* readLinkState({
    ...input,
    linkPath: link,
  });

  const createLink = input.fileSystem.symlink(target, link).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        shadowFileSystemError({
          sharedHomePath: input.sharedHomePath,
          effectiveHomePath: input.effectiveHomePath,
          operation: "symlink",
          path: link,
          targetPath: target,
          entryName: input.entryName,
          cause,
        }),
    }),
  );
  const protect = protectSidecar({
    lease: input.lease,
    sharedHomePath: input.sharedHomePath,
    effectiveHomePath: input.effectiveHomePath,
    entryName: input.entryName,
    linkPath: link,
  });

  if (state._tag === "NotSymlink") {
    if (!isReplaceableSharedRuntimeEntry(input.entryName)) {
      return yield* new CodexShadowHomeEntryConflictError({
        sharedHomePath: input.sharedHomePath,
        effectiveHomePath: input.effectiveHomePath,
        entryName: input.entryName,
        linkPath: link,
        targetPath: target,
      });
    }

    if (input.entryName === "thread-writer-locks") {
      const lockNames = yield* input.fileSystem.readDirectory(link).pipe(
        Effect.catchTags({
          PlatformError: (cause) =>
            new CodexShadowHomeFileSystemError({
              sharedHomePath: input.sharedHomePath,
              effectiveHomePath: input.effectiveHomePath,
              operation: "readDirectory",
              path: link,
              entryName: input.entryName,
              cause,
            }),
        }),
      );
      // Codex deletes a thread lock on release, so one that is left may still guard a live
      // writer. Keep the local directory until a later setup finds none.
      if (lockNames.some((name) => name.endsWith(".lock") && name !== ".coordination.lock")) {
        return yield* Effect.logWarning(
          "Codex shadow home still has thread writer locks; it will share them on a later setup.",
          { path: link },
        );
      }
    }

    yield* releaseHeldSidecar(input.lease, link);
    yield* removeShadowEntry({
      ...input,
      linkPath: link,
      recursive: true,
    });
    yield* createLink;
    return yield* protect;
  }

  if (state._tag === "Missing") {
    yield* createLink;
    return yield* protect;
  }

  const resolvedExisting = path.resolve(path.dirname(link), state.target);
  if (resolvedExisting !== target) {
    yield* releaseHeldSidecar(input.lease, link);
    yield* removeShadowEntry({
      ...input,
      linkPath: link,
    });
    yield* createLink;
  }
  yield* protect;
});

const ensureShadowAuthIsPrivate = Effect.fn("CodexHomeLayout.ensureShadowAuthIsPrivate")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly sharedHomePath: string;
    readonly effectiveHomePath: string;
  }): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
    const path = yield* Path.Path;
    const entryName = "auth.json";
    const authPath = path.join(input.effectiveHomePath, entryName);
    const state = yield* readLinkState({
      ...input,
      entryName,
      linkPath: authPath,
    });
    if (state._tag === "Symlink") {
      return yield* new CodexShadowHomePrivateEntrySymlinkError({
        sharedHomePath: input.sharedHomePath,
        effectiveHomePath: input.effectiveHomePath,
        entryName,
        path: authPath,
      });
    }
  },
);

export const materializeCodexShadowHome = Effect.fn("materializeCodexShadowHome")(function* (
  layout: CodexHomeLayout,
) {
  if (layout.mode !== "authOverlay") return;
  const effectiveHomePath = layout.effectiveHomePath;
  if (!effectiveHomePath) return;
  if (layout.sharedHomePath === effectiveHomePath) {
    return yield* new CodexShadowHomePathConflictError({
      sharedHomePath: layout.sharedHomePath,
      effectiveHomePath,
    });
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lease: SidecarLease = { paths: [] };
  yield* Effect.addFinalizer(() =>
    Effect.promise(() =>
      Promise.all(
        lease.paths.splice(0).map((linkPath) => releaseCodexShadowSqliteSidecar(linkPath)),
      ).then(() => undefined),
    ),
  );

  const makeDirectory = (directoryPath: string) =>
    fileSystem.makeDirectory(directoryPath, { recursive: true }).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new CodexShadowHomeFileSystemError({
            sharedHomePath: layout.sharedHomePath,
            effectiveHomePath,
            operation: "makeDirectory",
            path: directoryPath,
            cause,
          }),
      }),
    );

  yield* Effect.all(
    [
      makeDirectory(layout.sharedHomePath),
      makeDirectory(effectiveHomePath),
      ...KNOWN_SHARED_DIRECTORIES.map((directory) =>
        makeDirectory(path.join(layout.sharedHomePath, directory)),
      ),
    ],
    { concurrency: "unbounded" },
  );

  yield* quarantineShadowDatabaseBackups({
    sharedHomePath: layout.sharedHomePath,
    effectiveHomePath,
  });

  const sharedEntryNames = yield* fileSystem.readDirectory(layout.sharedHomePath).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        new CodexShadowHomeFileSystemError({
          sharedHomePath: layout.sharedHomePath,
          effectiveHomePath,
          operation: "readDirectory",
          path: layout.sharedHomePath,
          cause,
        }),
    }),
  );
  const entries = new Set<string>(KNOWN_SHARED_DIRECTORIES);
  for (const entryName of sharedEntryNames) {
    if (!PRIVATE_ENTRY_NAMES.has(entryName) && !SHADOW_LOCAL_ENTRY_NAMES.has(entryName)) {
      entries.add(entryName);
      if (SHARED_SQLITE_DATABASE_PATTERN.test(entryName)) {
        for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
          entries.add(`${entryName}${suffix}`);
        }
      }
    }
  }

  yield* Effect.forEach(
    PRIVATE_ENTRY_NAMES,
    (entryName) =>
      entryName === "auth.json"
        ? Effect.void
        : removePrivateSymlink({
            fileSystem,
            sharedHomePath: layout.sharedHomePath,
            effectiveHomePath,
            entryName,
          }),
    { discard: true },
  );

  yield* Effect.forEach(
    entries,
    (entryName) => {
      if (PRIVATE_ENTRY_NAMES.has(entryName)) {
        return Effect.void;
      }
      return ensureSymlink({
        fileSystem,
        sharedHomePath: layout.sharedHomePath,
        effectiveHomePath,
        entryName,
        lease,
      });
    },
    { discard: true },
  );

  yield* ensureShadowAuthIsPrivate({
    fileSystem,
    sharedHomePath: layout.sharedHomePath,
    effectiveHomePath,
  });
});

export function codexContinuationIdentity(layout: CodexHomeLayout) {
  return {
    driverKind: ProviderDriverKind.make("codex"),
    continuationKey: layout.continuationKey,
  };
}
