import type { ProviderInstanceConfig, ServerProvider } from "@t3tools/contracts";
import {
  promptSuggestionEffortOptions,
  selectPromptSuggestionModel,
  supportsPromptSuggestionsDriver,
} from "@t3tools/shared/promptSuggestions";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function PromptSuggestionSettings(props: {
  readonly instance: ProviderInstanceConfig;
  readonly provider: ServerProvider | undefined;
  readonly readOnly: boolean;
  readonly onUpdate: (instance: ProviderInstanceConfig) => void;
}) {
  const config = props.instance.promptSuggestions;
  const models = props.provider?.models ?? [];
  const selected = models.find((model) => model.slug === config?.model);
  const efforts = promptSuggestionEffortOptions(selected);
  const selectedEffort =
    efforts.find((effort) => effort.id === config?.reasoningEffort) ??
    efforts.find((effort) => effort.id === "low") ??
    efforts.find((effort) => effort.isDefault) ??
    efforts[0];
  const update = (next: NonNullable<typeof config>) =>
    props.onUpdate({ ...props.instance, promptSuggestions: next });
  if (!supportsPromptSuggestionsDriver(props.instance.driver)) {
    return (
      <SettingsSection title="Prompt suggestions">
        <SettingsRow
          title="Unavailable"
          description="This provider does not support prompt suggestions."
        />
      </SettingsSection>
    );
  }
  return (
    <SettingsSection title="Prompt suggestions">
      <SettingsRow
        title="Use this provider"
        description="Suggest a follow-up after a turn finishes. Also enable Prompt suggestions for this environment below."
        control={
          <Switch
            aria-label="Use this provider for prompt suggestions"
            checked={config?.enabled ?? false}
            disabled={props.readOnly || (!selected && !config?.enabled)}
            onCheckedChange={(enabled) => {
              if (config) update({ ...config, enabled });
            }}
          />
        }
      />
      <SettingsRow
        title="Suggestion model"
        description={
          models.length === 0
            ? "No models available. Connect and refresh this provider."
            : !selected && config
              ? "The saved model is unavailable. Select a model from this provider."
              : "Choose a model from this provider instance."
        }
        control={
          <Select
            value={selected?.slug ?? null}
            disabled={props.readOnly || models.length === 0}
            onValueChange={(slug) => {
              if (!slug) return;
              const next = selectPromptSuggestionModel(models, slug, config);
              if (next) update(next);
            }}
          >
            <SelectTrigger size="sm" aria-label="Suggestion model">
              <SelectValue placeholder="Choose model">
                {selected?.name ?? "Choose model"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {models.map((model) => (
                <SelectItem key={model.slug} value={model.slug}>
                  {model.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {selected && efforts.length > 0 && config ? (
        <SettingsRow
          title="Reasoning effort"
          control={
            <Select
              value={selectedEffort?.id ?? null}
              disabled={props.readOnly}
              onValueChange={(effort) => {
                if (effort && efforts.some((option) => option.id === effort))
                  update({ ...config, reasoningEffort: effort });
              }}
            >
              <SelectTrigger size="sm" aria-label="Suggestion reasoning effort">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {efforts.map((effort) => (
                  <SelectItem key={effort.id} value={effort.id}>
                    {effort.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      ) : null}
    </SettingsSection>
  );
}
