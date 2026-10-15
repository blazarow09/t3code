// @effect-diagnostics nodeBuiltinImport:off -- Standalone Windows watcher uses a local native-input helper.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const execute = NodeUtil.promisify(NodeChildProcess.execFile);
const decodeActivity = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ idleMs: Schema.Number, locked: Schema.Boolean })),
);

export function idleTimeoutMs(value: string | undefined): number {
  const minutes = value === undefined ? 3 : Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > Number.MAX_SAFE_INTEGER / 60_000) {
    throw new Error("T3CODE_ANDROID_PUSH_IDLE_TIMEOUT_MINUTES must be a positive number.");
  }
  return minutes * 60_000;
}

export const readDesktopActivity = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  if (platform !== "win32") return null;
  return yield* Effect.tryPromise(() =>
    execute(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        NodeURL.fileURLToPath(new URL("./android-push-desktop-activity.ps1", import.meta.url)),
      ],
      { windowsHide: true, timeout: 5_000, maxBuffer: 16_384 },
    ),
  ).pipe(
    Effect.flatMap(({ stdout }) => decodeActivity(stdout)),
    Effect.catch(() =>
      Effect.logWarning("Desktop activity detection unavailable; allowing completion alerts.").pipe(
        Effect.as(null),
      ),
    ),
  );
});
