// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodePath from "node:path";

import { ProviderDriverKind, type CodexSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";

export interface CodexHomeLayout {
  readonly mode: "direct" | "authOverlay";
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string | undefined;
  readonly continuationKey: string;
}

// Rollouts are the durable conversation history. Each account projects them
// into its own SQLite databases; the lock directory serializes rollout writes.
const SHARED_DIRECTORIES = [
  "sessions",
  "archived_sessions",
  "thread-writer-locks",
  "shell_snapshots",
  "generated_images",
  "skills",
  "rules",
  "agents",
] as const;
const SHARED_FILES = ["config.toml", "AGENTS.md"] as const;
const SHARED_ENTRIES = new Set<string>([...SHARED_DIRECTORIES, ...SHARED_FILES]);
const SQLITE_ENTRY_PATTERN = /\.(?:db|sqlite)(?:-(?:wal|shm|journal))?$/u;

function resolveHomePath(path: Path.Path, home: string, value: string | undefined): string {
  const expanded =
    value && value.trim().length > 0
      ? expandHomePath(value, home)
      : path.join(home, ".codex");
  return path.resolve(expanded);
}

export const resolveCodexHomeLayout = Effect.fn("resolveCodexHomeLayout")(function* (
  config: CodexSettings,
): Effect.fn.Return<CodexHomeLayout, never, Path.Path | HostProcess.HomeDirectory> {
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

  const effectiveHomePath = path.resolve(expandHomePath(shadowHomePath));
  return {
    mode: "authOverlay",
    sharedHomePath,
    effectiveHomePath,
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
      "inspect",
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

export class CodexShadowHomeMigrationRequiredError extends Schema.TaggedError<CodexShadowHomeMigrationRequiredError>()(
  "CodexShadowHomeMigrationRequiredError",
  {
    ...CodexShadowHomeContext,
    path: Schema.String,
  },
) {
  override get message(): string {
    return `Codex shadow home '${this.effectiveHomePath}' still links private state at '${this.path}'. Stop all Codex processes and migrate this home before starting the provider.`;
  }
}

export const CodexShadowHomeError = Schema.Union([
  CodexShadowHomeFileSystemError,
  CodexShadowHomePathConflictError,
  CodexShadowHomeEntryConflictError,
  CodexShadowHomePrivateEntrySymlinkError,
  CodexShadowHomeMigrationRequiredError,
]);
export type CodexShadowHomeError = typeof CodexShadowHomeError.Type;

type LinkState =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "NotSymlink" }
  | { readonly _tag: "Symlink"; readonly target: string };

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

function isWithin(path: string, root: string): boolean {
  const relative = NodePath.relative(root, path);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`) &&
      !NodePath.isAbsolute(relative))
  );
}

function findLegacySharedState(
  sharedHomePath: string,
  effectiveHomePath: string,
): string | undefined {
  const configPath = NodePath.join(sharedHomePath, "config.toml");
  if (
    NodeFS.existsSync(configPath) &&
    /^\s*sqlite_home\s*=/mu.test(NodeFS.readFileSync(configPath, "utf8"))
  ) {
    return configPath;
  }
  for (const entry of NodeFS.readdirSync(effectiveHomePath, { withFileTypes: true })) {
    const entryPath = NodePath.join(effectiveHomePath, entry.name);
    if (entry.isSymbolicLink()) {
      if (entry.name === "sqlite" || entry.name === "db-backups") return entryPath;
      const target = NodePath.resolve(effectiveHomePath, NodeFS.readlinkSync(entryPath));
      if (!SHARED_ENTRIES.has(entry.name) && isWithin(target, sharedHomePath)) {
        return entryPath;
      }
      if (SQLITE_ENTRY_PATTERN.test(entry.name)) return entryPath;
      continue;
    }
    if (SQLITE_ENTRY_PATTERN.test(entry.name) && entry.isFile()) {
      if (NodeFS.statSync(entryPath).nlink > 1) return entryPath;
    }
    if ((entry.name === "sqlite" || entry.name === "db-backups") && entry.isDirectory()) {
      const backupEntries = NodeFS.readdirSync(entryPath, { recursive: true, withFileTypes: true });
      const linked = backupEntries.find(
        (backup) =>
          backup.isSymbolicLink() ||
          (backup.isFile() &&
            SQLITE_ENTRY_PATTERN.test(backup.name) &&
            NodeFS.statSync(NodePath.join(backup.parentPath, backup.name)).nlink > 1),
      );
      if (linked) return NodePath.join(linked.parentPath, linked.name);
    }
  }
  return undefined;
}

const ensureSharedEntry = Effect.fn("CodexHomeLayout.ensureSharedEntry")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
  readonly entryName: string;
}): Effect.fn.Return<void, CodexShadowHomeError> {
  const target = input.path.join(input.sharedHomePath, input.entryName);
  const link = input.path.join(input.effectiveHomePath, input.entryName);
  const state = yield* readLinkState({ ...input, linkPath: link });
  if (state._tag === "NotSymlink") {
    return yield* new CodexShadowHomeEntryConflictError({
      sharedHomePath: input.sharedHomePath,
      effectiveHomePath: input.effectiveHomePath,
      entryName: input.entryName,
      linkPath: link,
      targetPath: target,
    });
  }
  if (state._tag === "Symlink") {
    if (input.path.resolve(input.path.dirname(link), state.target) === target) return;
    yield* input.fileSystem.remove(link).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new CodexShadowHomeFileSystemError({
            sharedHomePath: input.sharedHomePath,
            effectiveHomePath: input.effectiveHomePath,
            operation: "remove",
            path: link,
            entryName: input.entryName,
            cause,
          }),
      }),
    );
  }
  yield* input.fileSystem.symlink(target, link).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        new CodexShadowHomeFileSystemError({
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
});

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
      ...SHARED_DIRECTORIES.map((directory) =>
        makeDirectory(path.join(layout.sharedHomePath, directory)),
      ),
    ],
    { concurrency: "unbounded" },
  );

  const unsafePath = yield* Effect.try({
    try: () => findLegacySharedState(layout.sharedHomePath, effectiveHomePath),
    catch: (cause) =>
      new CodexShadowHomeFileSystemError({
        sharedHomePath: layout.sharedHomePath,
        effectiveHomePath,
        operation: "inspect",
        path: effectiveHomePath,
        cause,
      }),
  });
  if (unsafePath !== undefined) {
    return yield* new CodexShadowHomeMigrationRequiredError({
      sharedHomePath: layout.sharedHomePath,
      effectiveHomePath,
      path: unsafePath,
    });
  }

  const authPath = path.join(effectiveHomePath, "auth.json");
  const authState = yield* readLinkState({
    fileSystem,
    sharedHomePath: layout.sharedHomePath,
    effectiveHomePath,
    entryName: "auth.json",
    linkPath: authPath,
  });
  if (authState._tag === "Symlink") {
    return yield* new CodexShadowHomePrivateEntrySymlinkError({
      sharedHomePath: layout.sharedHomePath,
      effectiveHomePath,
      entryName: "auth.json",
      path: authPath,
    });
  }

  for (const entryName of SHARED_ENTRIES) {
    if (
      SHARED_FILES.some((file) => file === entryName) &&
      !(yield* fileSystem.exists(path.join(layout.sharedHomePath, entryName)))
    ) {
      continue;
    }
    yield* ensureSharedEntry({
      fileSystem,
      path,
      sharedHomePath: layout.sharedHomePath,
      effectiveHomePath,
      entryName,
    });
  }
});

export function codexContinuationIdentity(layout: CodexHomeLayout) {
  return {
    driverKind: ProviderDriverKind.make("codex"),
    continuationKey: layout.continuationKey,
  };
}
