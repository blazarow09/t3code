// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { CodexSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  CodexShadowHomeEntryConflictError,
  CodexShadowHomeMigrationRequiredError,
  CodexShadowHomePathConflictError,
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
} from "./CodexHomeLayout.ts";

const decodeSettings = Schema.decodeSync(CodexSettings);

const makeHomes = Effect.fn("CodexHomeLayout.test.makeHomes")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-codex-home-layout-" });
  const sharedHome = path.join(root, "shared");
  const shadowHome = path.join(root, "shadow");
  yield* fileSystem.makeDirectory(sharedHome);
  yield* fileSystem.makeDirectory(shadowHome);
  const layout = yield* resolveCodexHomeLayout(
    decodeSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
  );
  return { fileSystem, path, sharedHome, shadowHome, layout };
});

it.layer(NodeServices.layer)("CodexHomeLayout", (it) => {
  describe("resolveCodexHomeLayout", () => {
    it.effect("keeps direct and shadow homes in the same continuation group", () =>
      Effect.gen(function* () {
        const { sharedHome, shadowHome, layout } = yield* makeHomes();
        const direct = yield* resolveCodexHomeLayout(decodeSettings({ homePath: sharedHome }));
        expect(direct).toMatchObject({
          mode: "direct",
          effectiveHomePath: sharedHome,
          continuationKey: `codex:home:${sharedHome}`,
        });
        expect(layout).toMatchObject({
          mode: "authOverlay",
          effectiveHomePath: shadowHome,
          continuationKey: direct.continuationKey,
        });
      }),
    );
  });

  describe("materializeCodexShadowHome", () => {
    it.effect("shares rollout files and locks while leaving SQLite and auth private", () =>
      Effect.gen(function* () {
        const { fileSystem, path, sharedHome, shadowHome, layout } = yield* makeHomes();
        yield* fileSystem.writeFileString(path.join(sharedHome, "config.toml"), "model = 'test'\n");
        yield* fileSystem.writeFileString(path.join(sharedHome, "AGENTS.md"), "Shared guidance\n");
        yield* fileSystem.writeFileString(path.join(sharedHome, "state_5.sqlite"), "shared-db\n");
        yield* fileSystem.writeFileString(path.join(shadowHome, "auth.json"), "private-auth\n");

        yield* materializeCodexShadowHome(layout);
        yield* materializeCodexShadowHome(layout);

        for (const entry of [
          "sessions",
          "archived_sessions",
          "thread-writer-locks",
          "shell_snapshots",
          "generated_images",
          "skills",
          "rules",
          "agents",
          "config.toml",
          "AGENTS.md",
        ]) {
          expect(yield* fileSystem.readLink(path.join(shadowHome, entry))).toBe(
            path.join(sharedHome, entry),
          );
        }
        for (const entry of [
          "sqlite",
          "state_5.sqlite",
          "state_5.sqlite-wal",
          "cache",
          "plugins",
        ]) {
          expect(NodeFS.existsSync(path.join(shadowHome, entry))).toBe(false);
        }
        expect(yield* fileSystem.readFileString(path.join(shadowHome, "auth.json"))).toBe(
          "private-auth\n",
        );
        expect(yield* fileSystem.readFileString(path.join(sharedHome, "state_5.sqlite"))).toBe(
          "shared-db\n",
        );
      }),
    );

    it.effect("preserves a healthy private SQLite database", () =>
      Effect.gen(function* () {
        const { fileSystem, path, sharedHome, shadowHome, layout } = yield* makeHomes();
        yield* fileSystem.writeFileString(
          path.join(sharedHome, "thread_history_1.sqlite"),
          "shared\n",
        );
        yield* fileSystem.writeFileString(
          path.join(shadowHome, "thread_history_1.sqlite"),
          "private\n",
        );

        yield* materializeCodexShadowHome(layout);

        expect(
          yield* fileSystem.readFileString(path.join(shadowHome, "thread_history_1.sqlite")),
        ).toBe("private\n");
        expect(NodeFS.statSync(path.join(shadowHome, "thread_history_1.sqlite")).ino).not.toBe(
          NodeFS.statSync(path.join(sharedHome, "thread_history_1.sqlite")).ino,
        );
      }),
    );

    it.effect("rejects a legacy database hardlink before creating any shared entries", () =>
      Effect.gen(function* () {
        const { fileSystem, path, sharedHome, shadowHome, layout } = yield* makeHomes();
        const sharedDatabase = path.join(sharedHome, "logs_2.sqlite");
        const shadowDatabase = path.join(shadowHome, "logs_2.sqlite");
        yield* fileSystem.writeFileString(sharedDatabase, "live-db\n");
        NodeFS.linkSync(sharedDatabase, shadowDatabase);

        const error = yield* materializeCodexShadowHome(layout).pipe(Effect.flip);
        expect(error).toBeInstanceOf(CodexShadowHomeMigrationRequiredError);
        if (error._tag !== "CodexShadowHomeMigrationRequiredError") return expect.fail();
        expect(error.path).toBe(shadowDatabase);
        expect(NodeFS.existsSync(path.join(shadowHome, "sessions"))).toBe(false);
        expect(yield* fileSystem.readFileString(sharedDatabase)).toBe("live-db\n");
      }),
    );

    it.effect("rejects a legacy SQLite sidecar symlink", () =>
      Effect.gen(function* () {
        const { fileSystem, path, sharedHome, shadowHome, layout } = yield* makeHomes();
        const sidecar = "state_5.sqlite-wal";
        yield* fileSystem.writeFileString(path.join(sharedHome, sidecar), "wal\n");
        yield* fileSystem.symlink(path.join(sharedHome, sidecar), path.join(shadowHome, sidecar));

        const error = yield* materializeCodexShadowHome(layout).pipe(Effect.flip);
        expect(error).toBeInstanceOf(CodexShadowHomeMigrationRequiredError);
        if (error._tag !== "CodexShadowHomeMigrationRequiredError") return expect.fail();
        expect(error.path).toBe(path.join(shadowHome, sidecar));
      }),
    );

    it.effect("rejects legacy linked runtime directories and database backups", () =>
      Effect.gen(function* () {
        const { fileSystem, path, sharedHome, shadowHome, layout } = yield* makeHomes();
        yield* fileSystem.makeDirectory(path.join(sharedHome, "sqlite"));
        yield* fileSystem.symlink(path.join(sharedHome, "sqlite"), path.join(shadowHome, "sqlite"));
        const directoryError = yield* materializeCodexShadowHome(layout).pipe(Effect.flip);
        expect(directoryError).toBeInstanceOf(CodexShadowHomeMigrationRequiredError);

        yield* fileSystem.remove(path.join(shadowHome, "sqlite"));
        const backupDir = path.join(shadowHome, "db-backups", "sqlite-1");
        yield* fileSystem.makeDirectory(backupDir, { recursive: true });
        yield* fileSystem.writeFileString(path.join(sharedHome, "logs_2.sqlite"), "db\n");
        yield* fileSystem.symlink(
          path.join(sharedHome, "logs_2.sqlite"),
          path.join(backupDir, "logs_2.sqlite"),
        );
        const backupError = yield* materializeCodexShadowHome(layout).pipe(Effect.flip);
        expect(backupError).toBeInstanceOf(CodexShadowHomeMigrationRequiredError);
      }),
    );

    it.effect("rejects a private SQLite directory link outside the shared home", () =>
      Effect.gen(function* () {
        const { fileSystem, path, shadowHome, layout } = yield* makeHomes();
        const external = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-codex-external-sqlite-",
        });
        yield* fileSystem.symlink(external, path.join(shadowHome, "sqlite"));
        const error = yield* materializeCodexShadowHome(layout).pipe(Effect.flip);
        expect(error).toBeInstanceOf(CodexShadowHomeMigrationRequiredError);
      }),
    );

    it.effect("rejects a shared sqlite_home config override", () =>
      Effect.gen(function* () {
        const { fileSystem, path, sharedHome, layout } = yield* makeHomes();
        yield* fileSystem.writeFileString(
          path.join(sharedHome, "config.toml"),
          'sqlite_home = "C:/shared/sqlite"\n',
        );
        const error = yield* materializeCodexShadowHome(layout).pipe(Effect.flip);
        expect(error).toBeInstanceOf(CodexShadowHomeMigrationRequiredError);
      }),
    );

    it.effect("rejects identical shared and shadow paths", () =>
      Effect.gen(function* () {
        const { sharedHome } = yield* makeHomes();
        const layout = yield* resolveCodexHomeLayout(
          decodeSettings({ homePath: sharedHome, shadowHomePath: sharedHome }),
        );
        expect(yield* materializeCodexShadowHome(layout).pipe(Effect.flip)).toBeInstanceOf(
          CodexShadowHomePathConflictError,
        );
      }),
    );

    it.effect("rejects a real file at a shared entry", () =>
      Effect.gen(function* () {
        const { fileSystem, path, shadowHome, layout } = yield* makeHomes();
        yield* fileSystem.writeFileString(path.join(shadowHome, "sessions"), "private\n");
        const error = yield* materializeCodexShadowHome(layout).pipe(Effect.flip);
        expect(error).toBeInstanceOf(CodexShadowHomeEntryConflictError);
        if (error._tag !== "CodexShadowHomeEntryConflictError") return expect.fail();
        expect(error.entryName).toBe("sessions");
      }),
    );
  });
});
