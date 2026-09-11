import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { desktopDir, resolveElectronLaunchCommand } from "./electron-launcher.mjs";

const mainEntryPath = NodePath.join(desktopDir, "dist-electron", "main.cjs");
if (!NodeFS.existsSync(mainEntryPath)) {
  console.error(
    `Unable to find Electron app at ${mainEntryPath}.\n` +
      "Build the desktop main process first:\n" +
      "  vp run --filter @t3tools/desktop build\n" +
      "Or start the watched desktop stack:\n" +
      "  npm run dev:desktop",
  );
  process.exit(1);
}

NodeChildProcess.execFileSync(
  process.execPath,
  [NodePath.join(desktopDir, "scripts/build-browser-secret.mjs")],
  { stdio: "inherit" },
);

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

const electronCommand = resolveElectronLaunchCommand(["dist-electron/main.cjs"]);
const child = NodeChildProcess.spawn(electronCommand.electronPath, electronCommand.args, {
  stdio: "inherit",
  cwd: desktopDir,
  env: childEnv,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
