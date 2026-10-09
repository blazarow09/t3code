import {
  type ServerSettings,
  type ServerProvider,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerProviderModel,
} from "@t3tools/contracts";

export function promptSuggestionProviderInstance(
  settings: Pick<ServerSettings, "providerInstances">,
  provider: Pick<ServerProvider, "instanceId" | "driver" | "enabled">,
): ProviderInstanceConfig {
  return (
    settings.providerInstances[provider.instanceId] ?? {
      driver: provider.driver,
      enabled: provider.enabled,
    }
  );
}

export function supportsPromptSuggestionsDriver(driver: string) {
  return driver === "codex" || driver === "claudeAgent" || driver === "antigravity";
}

export function promptSuggestionEffortOptions(model: ServerProviderModel | undefined) {
  const descriptor = model?.capabilities?.optionDescriptors?.find(
    (option) =>
      (option.id === "reasoningEffort" || option.id === "effort") && option.type === "select",
  );
  return descriptor?.type === "select" ? descriptor.options : [];
}

/** A suggestion model must be selected from this instance's current catalog. */
export function selectPromptSuggestionModel(
  models: ReadonlyArray<ServerProviderModel>,
  slug: string,
  current: ProviderInstanceConfig["promptSuggestions"],
) {
  const model = models.find((candidate) => candidate.slug === slug);
  if (!model) return undefined;
  const efforts = promptSuggestionEffortOptions(model);
  const reasoningEffort =
    efforts.find((option) => option.id === "low")?.id ??
    efforts.find((option) => option.isDefault)?.id ??
    efforts[0]?.id;
  return {
    enabled: current?.enabled ?? false,
    model: model.slug,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

export function updatePromptSuggestionInstance(
  instances: Readonly<Record<ProviderInstanceId, ProviderInstanceConfig>>,
  instanceId: ProviderInstanceId,
  instance: ProviderInstanceConfig,
  promptSuggestions: NonNullable<ProviderInstanceConfig["promptSuggestions"]>,
) {
  return { ...instances, [instanceId]: { ...instance, promptSuggestions } };
}
