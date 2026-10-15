import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  type CodexSettings,
  DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
  type ServerProviderModel,
  TextGenerationError,
} from "@t3tools/contracts";
import type { TextGenerationUsage } from "@t3tools/provider-core/server/textGeneration";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { codexExecLaunchArgs, resolveCodexLaunchArgs } from "../provider/codexLaunchArgs.ts";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import {
  normalizeCliError,
  toJsonSchemaObject,
} from "@t3tools/provider-core/server/textGenerationUtils";
import {
  PROMPT_SUGGESTION_SYSTEM_PROMPT,
  PROMPT_SUGGESTION_TIMEOUT_MS,
} from "@t3tools/provider-core/server/textGenerationPrompts";
import { codexModelFamily, getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { getCodexServiceTierOptionValue } from "../codexModelOptions.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";

const CODEX_TIMEOUT_MS = 180_000;
const CODEX_MCP_LIST_TIMEOUT_MS = 10_000;
// Plugins/apps add MCP servers; use trailing config overrides because --disable loses to user -c flags.
const CODEX_NO_PLUGIN_ARGS = [
  "--config",
  "features.plugins=false",
  "--config",
  "features.apps=false",
] as const;
const CodexMcpServers = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ name: Schema.String, enabled: Schema.Boolean })),
);
const decodeCodexMcpServers = Schema.decodeEffect(CodexMcpServers);

// mcp_servers={} merges instead of replacing; disable named entries and quote dotted names.
const codexMcpServersOff = (names: ReadonlyArray<string>): string | null =>
  names.length === 0
    ? null
    : `mcp_servers={${names.map((name) => `${JSON.stringify(name)}={enabled=false}`).join(",")}}`;
const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

const tokenCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const finiteNonNegative = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

const codexSpeed = (value: unknown): TextGenerationUsage["speed"] => {
  if (value === "ultrafast") return "ultrafast";
  if (value === "fast" || value === "priority") return "fast";
  if (value === "standard") return "standard";
  return undefined;
};

/** Reads the final cumulative usage event from `codex exec --json` output. */
export function extractCodexSuggestionUsage(output: string): TextGenerationUsage | undefined {
  let result: TextGenerationUsage | undefined;
  for (const line of output.split(/\r?\n/u)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const event = record(parsed);
    if (event?.["type"] !== "turn.completed") continue;
    const usage = record(event["usage"]);
    if (!usage) continue;

    const inputTokens = tokenCount(usage["input_tokens"]);
    const outputTokens = tokenCount(usage["output_tokens"]);
    if (inputTokens === undefined || outputTokens === undefined) continue;
    const cachedInputTokens = tokenCount(usage["cached_input_tokens"]) ?? 0;
    const cacheCreationTokens = tokenCount(usage["cache_creation_input_tokens"]) ?? 0;
    const reasoningTokens =
      tokenCount(usage["reasoning_output_tokens"]) ?? tokenCount(usage["reasoning_tokens"]) ?? 0;
    const model =
      typeof event["model"] === "string"
        ? event["model"]
        : typeof usage["model"] === "string"
          ? usage["model"]
          : undefined;
    const costUsd =
      finiteNonNegative(event["cost_usd"]) ??
      finiteNonNegative(usage["cost_usd"]) ??
      finiteNonNegative(event["total_cost_usd"]);
    const speed =
      codexSpeed(event["service_tier"] ?? usage["service_tier"] ?? usage["speed"]) ?? "standard";

    result = {
      totals: {
        uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens - cacheCreationTokens),
        cachedInputTokens,
        cacheCreationTokens,
        outputTokens,
        reasoningTokens: Math.min(outputTokens, reasoningTokens),
      },
      ...(model ? { model } : {}),
      ...(costUsd === undefined ? {} : { costUsd }),
      ...(speed === undefined ? {} : { speed }),
    };
  }
  return result;
}
/**
 * Build a Codex text-generation closure bound to a specific `CodexSettings`
 * payload. See `makeCodexAdapter` for the overall per-instance rationale.
 */
export const makeCodexTextGeneration = Effect.fn("makeCodexTextGeneration")(function* (
  codexConfig: CodexSettings,
  environment?: NodeJS.ProcessEnv,
  getModels: Effect.Effect<ReadonlyArray<ServerProviderModel>> = Effect.succeed([]),
  resolveRuntime?: Effect.Effect<
    import("../provider/CodexManagedRuntime.ts").CodexEffectiveRuntime,
    import("@t3tools/contracts").ProviderSetupError,
    Scope.Scope
  >,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverConfig = yield* Effect.service(ServerConfig.ServerConfig);
  const resolvedEnvironment = environment ?? process.env;

  const readStreamAsString = <E>(
    operation: string,
    stream: Stream.Stream<Uint8Array, E>,
  ): Effect.Effect<string, TextGenerationError> =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
      Effect.mapError((cause) =>
        normalizeCliError("codex", operation, cause, "Failed to collect process output"),
      ),
    );

  const removeTempFileDir = (filePath: string): Effect.Effect<void, never> =>
    fileSystem.remove(path.dirname(filePath), { recursive: true }).pipe(Effect.ignore);

  // Background fibers may inherit closed scopes that immediately reap temp files; write unscoped.
  const writeTempFile = (
    operation: string,
    prefix: string,
    content: string,
  ): Effect.Effect<string, TextGenerationError> =>
    fileSystem
      .makeTempFile({
        prefix: `t3code-${prefix}-${process.pid}-`,
      })
      .pipe(
        Effect.tap((filePath) =>
          fileSystem
            .writeFileString(filePath, content)
            .pipe(Effect.onError(() => removeTempFileDir(filePath))),
        ),
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: `Failed to write temp file`,
              cause,
            }),
        ),
      );

  const encodeJsonForOperation = (
    operation: TextGenerationOperations.Operation,
    value: unknown,
  ): Effect.Effect<string, TextGenerationError> =>
    encodeJsonString(value).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "Failed to encode structured output schema.",
            cause,
          }),
      ),
    );

  const materializeImageAttachments = Effect.fn("materializeImageAttachments")(function* (
    attachments: TextGenerationOperations.Request<Schema.Top>["attachments"],
  ) {
    if (!attachments || attachments.length === 0) {
      return [];
    }

    const imagePaths: string[] = [];
    for (const attachment of attachments) {
      if (attachment.type !== "image") {
        continue;
      }

      const resolvedPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      if (!resolvedPath || !path.isAbsolute(resolvedPath)) {
        continue;
      }
      const fileInfo = yield* fileSystem.stat(resolvedPath).pipe(Effect.orElseSucceed(() => null));
      if (!fileInfo || fileInfo.type !== "File") {
        continue;
      }
      imagePaths.push(resolvedPath);
    }
    return imagePaths;
  });

  const listEnabledMcpServers = Effect.fn("listEnabledMcpServers")(
    function* (input: {
      readonly binary: string;
      readonly cwd: string;
      readonly env: NodeJS.ProcessEnv;
      readonly launchArgs: ReadonlyArray<string>;
    }) {
      const spawnCommand = yield* resolveSpawnCommand(
        input.binary,
        [...input.launchArgs, ...CODEX_NO_PLUGIN_ARGS, "mcp", "list", "--json"],
        { env: input.env },
      );
      const child = yield* commandSpawner.spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          env: input.env,
          cwd: input.cwd,
          shell: spawnCommand.shell,
          forceKillAfter: "1 second",
        }),
      );
      const [stdout, , exitCode] = yield* Effect.all(
        [
          child.stdout.pipe(Stream.decodeText(), Stream.mkString),
          child.stderr.pipe(Stream.runDrain),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (exitCode !== 0) {
        yield* Effect.logWarning("codex mcp list failed; text generation keeps its MCP servers", {
          reason: "exit",
          exitCode,
        });
        return [];
      }
      const servers = yield* decodeCodexMcpServers(stdout).pipe(
        Effect.tapError(() =>
          Effect.logWarning("codex mcp list failed; text generation keeps its MCP servers", {
            reason: "decode",
          }),
        ),
      );
      return servers.filter((server) => server.enabled).map((server) => server.name);
    },
    Effect.scoped,
    Effect.timeoutOption(CODEX_MCP_LIST_TIMEOUT_MS),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.logWarning("codex mcp list failed; text generation keeps its MCP servers", {
            reason: "timeout",
          }).pipe(Effect.as<ReadonlyArray<string>>([])),
        onSome: (names) => Effect.succeed(names),
      }),
    ),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );

  const runCodexJson = Effect.fn("runCodexJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchema: outputSchemaJson,
    modelSelection,
    attachments,
    investigate,
    onUsage,
  }: TextGenerationOperations.Request<S>): Effect.fn.Return<
    S["Type"],
    TextGenerationError,
    S["DecodingServices"]
  > {
    const suggestion = operation === "generatePromptSuggestion";
    const imagePaths = yield* materializeImageAttachments(attachments);
    const schemaJson = yield* encodeJsonForOperation(
      operation,
      toJsonSchemaObject(outputSchemaJson),
    );
    const schemaPath = yield* writeTempFile(operation, "codex-schema", schemaJson);
    const outputPath = yield* writeTempFile(operation, "codex-output", "").pipe(
      Effect.onError(() => removeTempFileDir(schemaPath)),
    );

    const instructionsPath = suggestion
      ? yield* writeTempFile(
          operation,
          "codex-suggestion-instructions",
          PROMPT_SUGGESTION_SYSTEM_PROMPT,
        )
      : undefined;
    const instructionsConfig = instructionsPath
      ? yield* encodeJsonForOperation(operation, instructionsPath)
      : undefined;
    let codexStdout = "";
    let reportedUsage = false;
    const reportUsage = Effect.sync(() => {
      if (reportedUsage || !onUsage) return;
      const usage = extractCodexSuggestionUsage(codexStdout);
      if (!usage) return;
      reportedUsage = true;
      onUsage(usage);
    });

    const runCodexCommand = Effect.fn("runCodexJson.runCodexCommand")(function* () {
      const resolved = resolveRuntime
        ? yield* resolveRuntime.pipe(
            Effect.mapError(
              (cause) => new TextGenerationError({ operation, detail: cause.detail }),
            ),
          )
        : undefined;
      const effectiveConfig = resolved?.config ?? codexConfig;
      const effectiveEnvironment = resolved?.environment ?? resolvedEnvironment;
      const models = yield* getModels;
      const requestedModel = modelSelection.model;
      const model =
        models.find((candidate) => candidate.slug === requestedModel)?.slug ??
        models.find(
          (candidate) => !candidate.isCustom && codexModelFamily(candidate.slug) === requestedModel,
        )?.slug ??
        requestedModel;
      const launchArgs = resolveCodexLaunchArgs(effectiveConfig.launchArgs, effectiveEnvironment);
      const workingDirectory = suggestion
        ? yield* fileSystem
            .makeTempDirectoryScoped({ prefix: "t3code-codex-suggestion-" })
            .pipe(
              Effect.mapError((cause) =>
                normalizeCliError(
                  "codex",
                  operation,
                  cause,
                  "Failed to create suggestion directory",
                ),
              ),
            )
        : cwd;
      const reasoningEffort =
        getModelSelectionStringOptionValue(modelSelection, "reasoningEffort") ??
        DEFAULT_TEXT_GENERATION_REASONING_EFFORT;
      const serviceTier = suggestion
        ? "default"
        : resolved
          ? undefined
          : getCodexServiceTierOptionValue(modelSelection);
      const binary = effectiveConfig.binaryPath || "codex";
      const env = {
        ...effectiveEnvironment,
        ...(effectiveConfig.homePath
          ? {
              CODEX_HOME: expandHomePath(
                effectiveConfig.homePath,
                yield* HostProcess.HomeDirectory,
              ),
            }
          : {}),
      };
      const execLaunchArgs = codexExecLaunchArgs(launchArgs);
      const mcpServersOff = yield* listEnabledMcpServers({
        binary,
        cwd: workingDirectory,
        env,
        // `codex mcp` rejects --strict-config; the overrides still apply.
        launchArgs: execLaunchArgs.filter((arg) => arg !== "--strict-config"),
      }).pipe(Effect.map(codexMcpServersOff));
      const spawnCommand = yield* resolveSpawnCommand(
        binary,
        [
          "exec",
          ...execLaunchArgs,
          // A user's MCP server could act on the text-generation prompt.
          ...CODEX_NO_PLUGIN_ARGS,
          ...(mcpServersOff ? ["--config", mcpServersOff] : []),
          ...(suggestion ? ["--json"] : []),
          ...(suggestion
            ? [
                "--ignore-rules",
                "--config",
                "project_doc_max_bytes=0",
                "--config",
                `model_instructions_file=${instructionsConfig}`,
                "--config",
                'developer_instructions=""',
                "--config",
                'web_search="disabled"',
                "--config",
                "mcp_servers={}",
                "--config",
                "features.skip_host_skill_discovery=true",
                ...[
                  "shell_tool",
                  "unified_exec",
                  "shell_snapshot",
                  "multi_agent",
                  "multi_agent_v2",
                  "apps",
                  "plugins",
                  "hooks",
                  "memories",
                  "goals",
                  "browser_use",
                  "computer_use",
                  "image_generation",
                  "view_image",
                  "code_mode_host",
                  "sleep_tool",
                  "skill_search",
                ].flatMap((feature) => ["--config", `features.${feature}=false`]),
              ]
            : []),
          "--ephemeral",
          "--skip-git-repo-check",
          "-s",
          "read-only",
          "--model",
          model,
          "--config",
          `model_reasoning_effort="${reasoningEffort}"`,
          ...(serviceTier ? ["--config", `service_tier="${serviceTier}"`] : []),
          "--output-schema",
          schemaPath,
          "--output-last-message",
          outputPath,
          ...imagePaths.flatMap((imagePath) => ["--image", imagePath]),
          "-",
        ],
        { env: effectiveEnvironment },
      );
      const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env,
        cwd: workingDirectory,
        shell: spawnCommand.shell,
        stdin: {
          stream: Stream.encodeText(Stream.make(prompt)),
        },
        forceKillAfter: "1 second",
      });

      const child = yield* commandSpawner
        .spawn(command)
        .pipe(
          Effect.mapError((cause) =>
            normalizeCliError("codex", operation, cause, "Failed to spawn Codex CLI process"),
          ),
        );

      const collectStdout = suggestion
        ? child.stdout.pipe(
            Stream.decodeText(),
            Stream.runForEach((chunk) =>
              Effect.sync(() => {
                codexStdout += chunk;
              }),
            ),
            Effect.map(() => codexStdout),
            Effect.mapError((cause) =>
              normalizeCliError("codex", operation, cause, "Failed to collect process output"),
            ),
          )
        : readStreamAsString(operation, child.stdout);
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectStdout,
          readStreamAsString(operation, child.stderr),
          child.exitCode.pipe(
            Effect.mapError((cause) =>
              normalizeCliError("codex", operation, cause, "Failed to read Codex CLI exit code"),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      if (exitCode !== 0) {
        const stderrDetail = stderr.trim();
        const stdoutDetail = stdout.trim();
        const detail = stderrDetail.length > 0 ? stderrDetail : stdoutDetail;
        return yield* new TextGenerationError({
          operation,
          detail:
            detail.length > 0
              ? `Codex CLI command failed: ${detail}`
              : `Codex CLI command failed with code ${exitCode}.`,
        });
      }
    });

    const cleanup = Effect.all(
      [
        removeTempFileDir(schemaPath),
        removeTempFileDir(outputPath),
        ...(instructionsPath ? [removeTempFileDir(instructionsPath)] : []),
      ],
      {
        concurrency: "unbounded",
      },
    ).pipe(Effect.asVoid);

    return yield* Effect.gen(function* () {
      yield* runCodexCommand().pipe(
        Effect.ensuring(reportUsage),
        Effect.scoped,
        // The read-only sandbox already holds an investigation to reading; it only needs longer.
        Effect.timeoutOption(
          investigate?.timeoutMs ?? (suggestion ? PROMPT_SUGGESTION_TIMEOUT_MS : CODEX_TIMEOUT_MS),
        ),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({ operation, detail: "Codex CLI request timed out." }),
              ),
            onSome: () => Effect.void,
          }),
        ),
      );

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));

      return yield* fileSystem.readFileString(outputPath).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to read Codex output file.",
              cause,
            }),
        ),
        Effect.flatMap(decodeOutput),
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "Codex returned invalid structured output.",
                cause,
              }),
            ),
        }),
      );
    }).pipe(Effect.ensuring(cleanup));
  });

  return TextGenerationOperations.fromRunner("CodexTextGeneration", runCodexJson);
});
