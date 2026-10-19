import type { ProviderInstanceConfig, ServerProvider } from "@t3tools/contracts";
import {
  promptSuggestionEffortOptions,
  selectPromptSuggestionModel,
  supportsPromptSuggestionsDriver,
} from "@t3tools/shared/promptSuggestions";
import { useState } from "react";
import { Pressable } from "react-native";
import { AppText as Text } from "../../../components/ui/AppText";
import { SettingsRow } from "./SettingsRow";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

export function PromptSuggestionProviderSettings(props: {
  readonly provider: ServerProvider;
  readonly instance: ProviderInstanceConfig;
  readonly disabled: boolean;
  readonly onChange: (config: NonNullable<ProviderInstanceConfig["promptSuggestions"]>) => void;
}) {
  const [picker, setPicker] = useState<"model" | "effort" | null>(null);
  const config = props.instance.promptSuggestions;
  const selected = props.provider.models.find((model) => model.slug === config?.model);
  const efforts = promptSuggestionEffortOptions(selected);
  const selectedEffort =
    efforts.find((effort) => effort.id === config?.reasoningEffort) ??
    efforts.find((effort) => effort.id === "low") ??
    efforts.find((effort) => effort.isDefault) ??
    efforts[0];
  if (!supportsPromptSuggestionsDriver(props.provider.driver)) {
    return (
      <SettingsRow
        icon="text.alignleft"
        label="Prompt suggestions"
        value="Unavailable for this provider"
        disabled
      />
    );
  }
  return (
    <>
      <SettingsSwitchRow
        icon="text.alignleft"
        label="Prompt suggestions"
        subtitle="Also enable Prompt suggestions in Agent behavior."
        value={config?.enabled ?? false}
        disabled={props.disabled || (!selected && !config?.enabled)}
        onValueChange={(enabled) => {
          if (config) props.onChange({ ...config, enabled });
        }}
      />
      <SettingsRow
        icon="brain"
        label="Suggestion model"
        value={selected?.name ?? (config ? "Saved model unavailable" : "Choose model")}
        disabled={props.disabled || props.provider.models.length === 0}
        onPress={() => setPicker(picker === "model" ? null : "model")}
      />
      {picker === "model"
        ? props.provider.models.map((model) => (
            <Pressable
              key={model.slug}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected?.slug === model.slug }}
              disabled={props.disabled}
              className="border-t border-border-subtle px-4 py-3 active:opacity-70"
              onPress={() => {
                const next = selectPromptSuggestionModel(props.provider.models, model.slug, config);
                if (next) props.onChange(next);
                setPicker(null);
              }}
            >
              <Text className="text-base text-foreground">
                {model.name}
                {selected?.slug === model.slug ? " ✓" : ""}
              </Text>
            </Pressable>
          ))
        : null}
      {config && selected && efforts.length > 0 ? (
        <SettingsRow
          icon="brain"
          label="Suggestion reasoning effort"
          value={selectedEffort?.label}
          disabled={props.disabled}
          onPress={() => setPicker(picker === "effort" ? null : "effort")}
        />
      ) : null}
      {picker === "effort" && config
        ? efforts.map((effort) => (
            <Pressable
              key={effort.id}
              accessibilityRole="radio"
              accessibilityState={{ checked: selectedEffort?.id === effort.id }}
              disabled={props.disabled}
              className="border-t border-border-subtle px-4 py-3 active:opacity-70"
              onPress={() => {
                props.onChange({ ...config, reasoningEffort: effort.id });
                setPicker(null);
              }}
            >
              <Text className="text-base text-foreground">
                {effort.label}
                {selectedEffort?.id === effort.id ? " ✓" : ""}
              </Text>
            </Pressable>
          ))
        : null}
    </>
  );
}
