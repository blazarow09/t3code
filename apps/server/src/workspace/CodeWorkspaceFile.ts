/**
 * Maps a VS Code `.code-workspace` file onto a project: the file's own folder
 * becomes the project root, and workspace folders outside it become the
 * project's additional directories.
 *
 * @module CodeWorkspaceFile
 */
import type { FilesystemReadCodeWorkspaceResult } from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
// The package's UMD entry (its `main`) keeps `require("./impl/*")` relative to
// the emitted bundle, which the server sidecar cannot resolve. Import the ESM
// entry so the server bundle inlines the parser instead of the UMD wrapper.
import { parse as parseJsonc, type ParseError } from "jsonc-parser/lib/esm/main.js";

import { expandHomePathWith } from "@t3tools/provider-core/server/pathExpansion";

export const CODE_WORKSPACE_EXTENSION = ".code-workspace";

export class CodeWorkspaceFileError extends Schema.TaggedError<CodeWorkspaceFileError>()(
  "CodeWorkspaceFileError",
  {
    path: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Could not read workspace file '${this.path}': ${this.detail}`;
  }
}

const isInsideOrEqual = (root: string, candidate: string) => {
  const normalizedRoot = normalizeProjectPathForComparison(root);
  const normalizedCandidate = normalizeProjectPathForComparison(candidate);
  const separator = normalizedRoot.includes("\\") ? "\\" : "/";
  const prefix = normalizedRoot.endsWith(separator)
    ? normalizedRoot
    : `${normalizedRoot}${separator}`;
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(prefix);
};

/** Pure mapping from file text to a project shape, using the host's path rules. */
export function mapCodeWorkspace(input: {
  readonly filePath: string;
  readonly text: string;
  readonly path: Pick<Path.Path, "basename" | "dirname" | "join" | "resolve">;
}): FilesystemReadCodeWorkspaceResult | string {
  const errors: Array<ParseError> = [];
  const parsed: unknown = parseJsonc(input.text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || typeof parsed !== "object" || parsed === null) {
    return "the file is not valid JSON.";
  }
  const folders = "folders" in parsed ? parsed.folders : undefined;
  if (!Array.isArray(folders)) {
    return "the file has no folders list.";
  }

  const workspaceRoot = input.path.dirname(input.path.resolve(input.filePath));
  const additionalDirectories: Array<string> = [];
  const seen = new Set<string>();
  for (const folder of folders) {
    const folderPath: unknown =
      typeof folder === "object" && folder !== null && "path" in folder ? folder.path : undefined;
    if (typeof folderPath !== "string" || folderPath.trim().length === 0) continue;
    const resolved = input.path.resolve(
      workspaceRoot,
      expandHomePathWith(folderPath.trim(), input.path),
    );
    if (isInsideOrEqual(workspaceRoot, resolved)) continue;
    const key = normalizeProjectPathForComparison(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    additionalDirectories.push(resolved);
  }

  const baseName = input.path.basename(input.filePath);
  const title = baseName.toLowerCase().endsWith(CODE_WORKSPACE_EXTENSION)
    ? baseName.slice(0, -CODE_WORKSPACE_EXTENSION.length)
    : baseName;
  return {
    title: title.trim() || input.path.basename(workspaceRoot) || workspaceRoot,
    workspaceRoot,
    additionalDirectories,
  };
}

export const readCodeWorkspace = Effect.fn("CodeWorkspaceFile.readCodeWorkspace")(function* (
  filePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolvedPath = path.resolve(expandHomePathWith(filePath.trim(), path));
  if (!resolvedPath.toLowerCase().endsWith(CODE_WORKSPACE_EXTENSION)) {
    return yield* new CodeWorkspaceFileError({
      path: resolvedPath,
      detail: `expected a ${CODE_WORKSPACE_EXTENSION} file.`,
    });
  }
  const text = yield* fileSystem.readFileString(resolvedPath).pipe(
    Effect.mapError(
      (cause) =>
        new CodeWorkspaceFileError({
          path: resolvedPath,
          detail: cause.reason._tag === "NotFound" ? "the file does not exist." : cause.message,
          cause,
        }),
    ),
  );
  const result = mapCodeWorkspace({ filePath: resolvedPath, text, path });
  if (typeof result === "string") {
    return yield* new CodeWorkspaceFileError({ path: resolvedPath, detail: result });
  }
  return result;
});
