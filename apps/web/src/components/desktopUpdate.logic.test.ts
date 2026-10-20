import { describe, expect, it } from "vite-plus/test";
import type { DesktopUpdateState } from "@t3tools/contracts";

import {
  canCheckForUpdate,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateReleaseHistoryUrl,
  getDesktopUpdateReleaseUrl,
  resolveDesktopUpdateButtonAction,
} from "./desktopUpdate.logic";

const baseState: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "1.0.0",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

describe("desktop update button state", () => {
  it("keeps retry action available after a download error", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      availableVersion: "1.1.0",
      message: "network timeout",
      errorContext: "download",
      canRetry: true,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
    expect(getDesktopUpdateButtonTooltip(state)).toContain("Click to retry");
  });

  it("prefers a newly available release over a stale downloaded version", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.2.0",
      downloadedVersion: "1.1.0",
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
  });

  it("hides the install action while checking for a newer release", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "checking",
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
      downloadPercent: 100,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("none");
  });
});

describe("desktop update UI helpers", () => {
  it.each(["owner/repo/extra", "owner#notes/repo", "owner/repo?tab=notes"])(
    "falls back to upstream for an invalid configured repository: %s",
    (repository) => {
      expect(getDesktopUpdateReleaseHistoryUrl(repository)).toBe(
        "https://github.com/pingdotgg/t3code/releases",
      );
      expect(getDesktopUpdateReleaseUrl("1.2.3", repository)).toBe(
        "https://github.com/pingdotgg/t3code/releases/tag/v1.2.3",
      );
    },
  );
});

describe("canCheckForUpdate", () => {
  it("returns true once an update has been downloaded so newer releases can be found", () => {
    expect(
      canCheckForUpdate({
        ...baseState,
        status: "downloaded",
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
      }),
    ).toBe(true);
  });

  it("returns true when idle", () => {
    expect(canCheckForUpdate({ ...baseState, status: "idle" })).toBe(true);
  });

  it("returns true when up-to-date", () => {
    expect(canCheckForUpdate({ ...baseState, status: "up-to-date" })).toBe(true);
  });

  it("returns true when an update is available", () => {
    expect(
      canCheckForUpdate({ ...baseState, status: "available", availableVersion: "1.1.0" }),
    ).toBe(true);
  });

  it("returns true on error so the user can retry", () => {
    expect(
      canCheckForUpdate({
        ...baseState,
        status: "error",
        errorContext: "check",
        message: "network",
      }),
    ).toBe(true);
  });
});

describe("getDesktopUpdateButtonTooltip", () => {
  it("does not describe stale counts as current after a failed check", () => {
    expect(
      getDesktopUpdateButtonTooltip({
        ...baseState,
        customSync: true,
        syncBehind: 1980,
        status: "error",
        message: "Could not compare this installed build with upstream.",
      }),
    ).toBe("Could not compare this installed build with upstream.");
  });

  it("describes upstream drift without offering a download", () => {
    expect(
      getDesktopUpdateButtonTooltip({
        ...baseState,
        customSync: true,
        syncBehind: 2,
        checkedAt: "2026-09-21T00:00:00.000Z",
      }),
    ).toBe("Upstream is 2 commits ahead of this build");
    expect(
      getDesktopUpdateButtonTooltip({
        ...baseState,
        customSync: true,
        syncBehind: 0,
        checkedAt: null,
      }),
    ).toBe("Check for upstream changes");
    expect(
      resolveDesktopUpdateButtonAction({ ...baseState, customSync: true, syncBehind: 4 }),
    ).toBe("none");
  });

  it("returns 'Up to date' for non-actionable states", () => {
    expect(getDesktopUpdateButtonTooltip({ ...baseState, status: "idle" })).toBe("Up to date");
    expect(getDesktopUpdateButtonTooltip({ ...baseState, status: "up-to-date" })).toBe(
      "Up to date",
    );
  });
});

describe("disabled update reason", () => {
  const disabledState: DesktopUpdateState = {
    ...baseState,
    enabled: false,
    status: "disabled",
    message: "Automatic updates are only available in packaged production builds.",
  };

  it("explains why checking is unavailable", () => {
    expect(getDesktopUpdateDisabledReason(disabledState)).toBe(
      "Automatic updates are only available in packaged production builds.",
    );
    expect(getDesktopUpdateIdleTooltip(disabledState)).toEqual({
      title: "Updates unavailable",
      detail: "Automatic updates are only available in packaged production builds.",
    });
    expect(getDesktopUpdateDisabledReason({ ...disabledState, message: null })).toBe(
      "Automatic updates are not available in this build.",
    );
  });

  it("keeps the check prompt when updates are available", () => {
    expect(getDesktopUpdateDisabledReason(baseState)).toBeNull();
    expect(getDesktopUpdateDisabledReason(null)).toBeNull();
    expect(getDesktopUpdateIdleTooltip(baseState)).toEqual({
      title: "Check for updates",
      detail: null,
    });
  });
});
