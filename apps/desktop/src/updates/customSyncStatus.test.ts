import { describe, expect, it } from "vite-plus/test";

import { parseCustomSyncCommitLog, selectCustomSyncBase } from "./customSyncStatus.ts";

describe("parseCustomSyncCommitLog", () => {
  it("reads a short sha and subject from each log line", () => {
    expect(
      parseCustomSyncCommitLog("abc1234\tFix the hood crease\ndef5678\tAdd the fender"),
    ).toEqual([
      { sha: "abc1234", subject: "Fix the hood crease" },
      { sha: "def5678", subject: "Add the fender" },
    ]);
  });

  it("ignores blank lines and lines that are not sha-tab-subject", () => {
    expect(parseCustomSyncCommitLog("\nnot a commit\nabc1234\n")).toEqual([]);
  });
});

describe("selectCustomSyncBase", () => {
  const input = {
    branch: "custom",
    syncBranch: "custom-sync",
    builtRevision: "25c84e88c6",
    builtRevisionResolves: true,
    syncBranchResolves: true,
  };

  it("counts from the commit the installer was built from", () => {
    expect(selectCustomSyncBase(input)).toBe("25c84e88c6");
  });

  it("uses the unfinalized sync branch when the build stamp is missing", () => {
    expect(
      selectCustomSyncBase({
        ...input,
        builtRevision: null,
        builtRevisionResolves: false,
      }),
    ).toBe("custom-sync");
  });

  it("falls back to the finalized branch when neither newer ref exists", () => {
    expect(
      selectCustomSyncBase({
        ...input,
        builtRevision: "missing",
        builtRevisionResolves: false,
        syncBranchResolves: false,
      }),
    ).toBe("custom");
  });
});
