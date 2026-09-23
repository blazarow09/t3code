import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";

/**
 * Codex names SQLite's `-wal` and `-shm` files from the path it opened. On a
 * shadow home those names are symlinks into the shared home, and a clean
 * Codex shutdown deletes the path it opened. That deletes the symlink. The
 * next launch creates a real sidecar beside the shadow home, so two WAL
 * files update one database and the file corrupts.
 *
 * Holding the reparse point open without `FILE_SHARE_DELETE` makes that
 * delete fail. Writes still follow the symlink into the shared sidecar.
 * Windows-only: other platforms resolve the database path before naming the
 * WAL.
 */
const GUARD_SCRIPT = [
  "$ProgressPreference = 'SilentlyContinue'",
  "[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false",
  "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false",
  "Add-Type -TypeDefinition @'",
  "using System;",
  "using System.Runtime.InteropServices;",
  "public static class T3CodexReparseGuard {",
  "  const uint GENERIC_READ = 0x80000000;",
  "  const uint FILE_SHARE_READ = 1;",
  "  const uint FILE_SHARE_WRITE = 2;",
  "  const uint OPEN_EXISTING = 3;",
  "  const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;",
  "  const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;",
  '  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]',
  "  static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr template);",
  '  [DllImport("kernel32.dll", SetLastError=true)]',
  "  static extern bool CloseHandle(IntPtr handle);",
  "  public static long Open(string path) {",
  "    var handle = CreateFile(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero);",
  "    if (handle == new IntPtr(-1)) return -Marshal.GetLastWin32Error();",
  "    return handle.ToInt64();",
  "  }",
  "  public static bool Close(long value) {",
  "    return CloseHandle(new IntPtr(value));",
  "  }",
  "}",
  "'@",
  "$handles = @{}",
  "while ($true) {",
  "  $line = [Console]::In.ReadLine()",
  "  if ($null -eq $line) { break }",
  '  $parts = $line.Trim().Split("`t", 2)',
  "  $op = $parts[0]",
  '  $path = if ($parts.Length -gt 1) { $parts[1] } else { "" }',
  '  if ($op -eq "quit") { break }',
  '  if ($op -eq "hold") {',
  "    if ($handles.ContainsKey($path)) { [Console]::Out.WriteLine('ok'); [Console]::Out.Flush(); continue }",
  "    $opened = [T3CodexReparseGuard]::Open($path)",
  "    if ($opened -lt 0) { [Console]::Out.WriteLine('err ' + (-$opened)); [Console]::Out.Flush(); continue }",
  "    $handles[$path] = $opened",
  "    [Console]::Out.WriteLine('ok')",
  "    [Console]::Out.Flush()",
  "    continue",
  "  }",
  '  if ($op -eq "release") {',
  "    if ($handles.ContainsKey($path)) {",
  "      [void][T3CodexReparseGuard]::Close([int64]$handles[$path])",
  "      [void]$handles.Remove($path)",
  "    }",
  "    [Console]::Out.WriteLine('ok')",
  "    [Console]::Out.Flush()",
  "    continue",
  "  }",
  "  [Console]::Out.WriteLine('err unknown')",
  "  [Console]::Out.Flush()",
  "}",
  "foreach ($value in @($handles.Values)) { [void][T3CodexReparseGuard]::Close([int64]$value) }",
].join("\n");

interface GuardProcess {
  readonly request: (op: "hold" | "release", path: string) => Promise<void>;
}

const counts = new Map<string, number>();
let queue: Promise<void> = Promise.resolve();
let guard: Promise<GuardProcess> | undefined;
let activeChild: NodeChildProcess.ChildProcess | undefined;

process.once("exit", () => {
  activeChild?.kill();
});

function enqueue(task: () => Promise<void>): Promise<void> {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function startGuard(): Promise<GuardProcess> {
  const encoded = Buffer.from(GUARD_SCRIPT, "utf16le").toString("base64");
  const child = NodeChildProcess.spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  const stderr: string[] = [];
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr.push(chunk);
    if (stderr.length > 20) stderr.shift();
  });
  const lines = NodeReadline.createInterface({ input: child.stdout });
  const pending: Array<(line: string) => void> = [];
  const incoming: string[] = [];
  lines.on("line", (line) => {
    const resolve = pending.shift();
    if (resolve) resolve(line);
    else incoming.push(line);
  });
  let failed: Error | undefined;
  const fail = (error: Error) => {
    if (failed) return;
    failed = error;
    guard = undefined;
    while (pending.length > 0) {
      pending.shift()?.(`err ${error.message}`);
    }
  };
  child.on("error", (error) => {
    fail(error);
  });
  child.on("exit", (code) => {
    if (activeChild === child) activeChild = undefined;
    fail(new Error(`Codex SQLite guard exited (${code}): ${stderr.join("").trim()}`));
  });
  activeChild = child;

  const request = (op: "hold" | "release", path: string) =>
    new Promise<void>((resolve, reject) => {
      if (failed) {
        reject(failed);
        return;
      }
      const timer = setTimeout(() => {
        reject(new Error(`Codex SQLite guard timed out during ${op} for ${path}`));
      }, 20_000);
      const finish = (line: string) => {
        clearTimeout(timer);
        if (line === "ok") resolve();
        else reject(new Error(`Codex SQLite guard ${op} failed for ${path}: ${line}`));
      };
      const queued = incoming.shift();
      if (queued !== undefined) finish(queued);
      else pending.push(finish);
      child.stdin?.write(`${op}\t${path}\n`);
    });

  return Promise.resolve({ request });
}

function guardProcess(): Promise<GuardProcess> {
  guard ??= startGuard();
  return guard;
}

export function holdCodexShadowSqliteSidecar(linkPath: string): Promise<void> {
  if (process.platform !== "win32") return Promise.resolve();
  return enqueue(async () => {
    const count = counts.get(linkPath) ?? 0;
    if (count === 0) {
      await (await guardProcess()).request("hold", linkPath);
    }
    counts.set(linkPath, count + 1);
  });
}

export function releaseCodexShadowSqliteSidecar(linkPath: string): Promise<void> {
  if (process.platform !== "win32") return Promise.resolve();
  return enqueue(async () => {
    const count = counts.get(linkPath) ?? 0;
    if (count > 1) {
      counts.set(linkPath, count - 1);
      return;
    }
    counts.delete(linkPath);
    const current = guard;
    if (!current) return;
    await (await current).request("release", linkPath);
  });
}
