import { describe, expect, it } from "vite-plus/test";

import {
  CUSTOM_SYNC_MODEL_SLUG,
  CUSTOM_SYNC_MODEL_OPTIONS,
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
  const otherProvider = {
    instanceId: "opencode",
    driver: "opencode",
    enabled: true,
    installed: true,
    models: [{ slug: CUSTOM_SYNC_MODEL_SLUG }],
  };
  const codex = {
    instanceId: "codex",
    driver: "codex",
    enabled: true,
    installed: true,
    models: [{ slug: "gpt-6-astra" }, { slug: "gpt-6-sol" }] as Array<{ slug: string }>,
  };

  it("selects Codex only when GPT-6.1 Sol is available", () => {
    const listed = {
      ...codex,
      instanceId: "codex-sol",
      models: [{ slug: "gpt-6.1-sol" }],
    };
    expect(selectCustomSyncProvider([otherProvider, codex, listed])?.instanceId).toBe("codex-sol");
  });

  it("does not start with a different model or provider", () => {
    expect(selectCustomSyncProvider([otherProvider, codex])).toBeNull();
  });

  it("skips an unavailable Codex instance", () => {
    expect(
      selectCustomSyncProvider([
        { ...codex, models: [{ slug: CUSTOM_SYNC_MODEL_SLUG }], availability: "unavailable" },
      ]),
    ).toBeNull();
  });

  it("pins medium reasoning effort", () => {
    expect(CUSTOM_SYNC_MODEL_OPTIONS).toEqual([{ id: "reasoningEffort", value: "medium" }]);
  });
});

describe("CUSTOM_SYNC_PROMPT", () => {
  it("names the skill and stops before install", () => {
    expect(CUSTOM_SYNC_PROMPT.startsWith(`$${CUSTOM_SYNC_SKILL_NAME}`)).toBe(true);
    expect(CUSTOM_SYNC_PROMPT).toContain("Stop before installing");
  });
});
