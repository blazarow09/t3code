import {
  ProviderInstanceId,
  ProviderDriverKind,
  DEFAULT_SERVER_SETTINGS,
  type ProviderInstanceConfig,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  promptSuggestionProviderInstance,
  promptSuggestionEffortOptions,
  selectPromptSuggestionModel,
  updatePromptSuggestionInstance,
} from "./promptSuggestions.ts";

const models: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "small",
    name: "Small",
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Effort",
          type: "select",
          options: [
            { id: "high", label: "High", isDefault: true },
            { id: "low", label: "Low" },
          ],
        },
      ],
    },
  },
  { slug: "plain", name: "Plain", capabilities: null, isCustom: false },
];

describe("prompt suggestion settings", () => {
  it("offers Claude effort choices and saves low as the suggestion reasoning effort", () => {
    const claudeModel: ServerProviderModel = {
      slug: "claude-small",
      name: "Claude Small",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Effort",
            type: "select",
            options: [
              { id: "high", label: "High", isDefault: true },
              { id: "low", label: "Low" },
            ],
          },
        ],
      },
    };
    expect(promptSuggestionEffortOptions(claudeModel).map((option) => option.id)).toEqual([
      "high",
      "low",
    ]);
    expect(selectPromptSuggestionModel([claudeModel], claudeModel.slug, undefined)).toEqual({
      enabled: false,
      model: "claude-small",
      reasoningEffort: "low",
    });
  });
  it("keeps existing instance settings and creates a fallback for unconfigured instances", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        ...DEFAULT_SERVER_SETTINGS.providerInstances,
        [ProviderInstanceId.make("codex")]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          config: { binaryPath: "custom-codex" },
        },
      },
    };
    const provider = {
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
    };
    expect(promptSuggestionProviderInstance(settings, provider).config).toMatchObject({
      binaryPath: "custom-codex",
    });
    expect(
      promptSuggestionProviderInstance(settings, {
        ...provider,
        instanceId: ProviderInstanceId.make("second-account"),
      }).config,
    ).toBeUndefined();
  });
  it("rejects models absent from the instance catalog and defaults supported effort to low", () => {
    expect(selectPromptSuggestionModel(models, "other-instance-model", undefined)).toBeUndefined();
    expect(selectPromptSuggestionModel(models, "small", undefined)).toEqual({
      enabled: false,
      model: "small",
      reasoningEffort: "low",
    });
    expect(
      selectPromptSuggestionModel(models, "plain", {
        enabled: true,
        model: "small",
        reasoningEffort: "high",
      }),
    ).toEqual({ enabled: true, model: "plain" });
  });

  it("preserves other instances, credentials, and runtime configuration", () => {
    const id = ProviderInstanceId.make("codex");
    const otherId = ProviderInstanceId.make("other");
    const instance: ProviderInstanceConfig = {
      driver: ProviderDriverKind.make("codex"),
      enabled: false,
      config: { binaryPath: "custom-codex" },
      environment: [{ name: "TOKEN", value: "", sensitive: true, valueRedacted: true }],
    };
    const other: ProviderInstanceConfig = {
      driver: ProviderDriverKind.make("claudeAgent"),
      displayName: "Other account",
    };
    const instances: Record<ProviderInstanceId, ProviderInstanceConfig> = {
      [id]: instance,
      [otherId]: other,
    };
    const next = updatePromptSuggestionInstance(instances, id, instance, {
      enabled: true,
      model: "small",
    });
    expect(next).toEqual({
      [id]: { ...instance, promptSuggestions: { enabled: true, model: "small" } },
      [otherId]: other,
    });
    expect(instances[id]).toBe(instance);
  });
});
