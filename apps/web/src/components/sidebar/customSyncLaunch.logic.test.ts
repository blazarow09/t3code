import { describe, expect, it } from "vite-plus/test";

import {
  CUSTOM_SYNC_MODEL_SLUG,
  CUSTOM_SYNC_PROMPT,
  CUSTOM_SYNC_SKILL_NAME,
  selectCustomSyncProject,
  selectCustomSyncProvider,
} from "./customSyncLaunch.logic";

describe("selectCustomSyncProject", () => {
  it("picks the t3code checkout on the primary environment", () => {
    const primary = {
      environmentId: "primary",
      workspaceRoot: "D:/Projects/t3code/",
    };
    const other = {
      environmentId: "other",
      workspaceRoot: "D:\\Projects\\t3code",
    };

    expect(selectCustomSyncProject([other, primary], "primary")).toBe(primary);
    expect(selectCustomSyncProject([other], "primary")).toBe(other);
  });

  it("ignores other checkouts", () => {
    expect(
      selectCustomSyncProject(
        [{ environmentId: "primary", workspaceRoot: "D:\\Projects\\JustAllThings" }],
        "primary",
      ),
    ).toBeNull();
  });
});

describe("selectCustomSyncProvider", () => {
  const cursor = {
    instanceId: "cursor",
    driver: "cursor",
    enabled: true,
    installed: true,
    models: [{ slug: CUSTOM_SYNC_MODEL_SLUG }],
  };
  const opencode = {
    instanceId: "opencode",
    driver: "opencode",
    enabled: true,
    installed: true,
    models: [] as Array<{ slug: string }>,
  };

  it("prefers the OpenCode instance that lists DeepSeek V4.1 Flash", () => {
    const listed = {
      ...opencode,
      instanceId: "opencode-deepseek",
      models: [{ slug: CUSTOM_SYNC_MODEL_SLUG }],
    };
    expect(selectCustomSyncProvider([cursor, opencode, listed])?.instanceId).toBe(
      "opencode-deepseek",
    );
  });

  it("falls back to any ready OpenCode instance", () => {
    expect(
      selectCustomSyncProvider([cursor, { ...opencode, enabled: false }, opencode])?.instanceId,
    ).toBe("opencode");
  });

  it("skips an unavailable OpenCode instance", () => {
    expect(selectCustomSyncProvider([{ ...opencode, availability: "unavailable" }])).toBeNull();
  });
});

describe("CUSTOM_SYNC_PROMPT", () => {
  it("names the skill and stops before install", () => {
    expect(CUSTOM_SYNC_PROMPT.startsWith(`$${CUSTOM_SYNC_SKILL_NAME}`)).toBe(true);
    expect(CUSTOM_SYNC_PROMPT).toContain("Stop before installing");
  });
});
