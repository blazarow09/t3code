import {
  formatPromptSuggestionAverageCost,
  formatPromptSuggestionCost,
  promptSuggestionTotalTokens,
  sumPromptSuggestionUsage,
  type MergedPromptSuggestionUsage,
} from "@t3tools/shared/usageMerge";
import { formatCount } from "@t3tools/shared/usageFormat";
import { View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { SettingsSection } from "../settings/components/SettingsSection";
import { PROVIDER_LABEL } from "./usageProviders";

export function PromptSuggestionUsageSection({
  usage,
}: {
  readonly usage: MergedPromptSuggestionUsage | undefined;
}) {
  const total = sumPromptSuggestionUsage(usage?.rows ?? []);
  return (
    <SettingsSection title="Prompt suggestions">
      <View className="gap-3 p-4">
        <Text className="text-xs text-foreground-muted">
          Tracked from this update onwards
          {usage?.trackingSince
            ? `; all selected ledgers track since ${new Date(usage.trackingSince).toLocaleDateString()}`
            : ""}
          . API-equivalent estimates are not subscription charges. Separate from transcript totals,
          which may already include these requests.
        </Text>
        {!usage || usage.unavailableEnvironments.length > 0 ? (
          <Text className="text-xs text-foreground-muted">
            Suggestion tracking is unavailable
            {usage?.unavailableEnvironments.length
              ? ` for ${usage.unavailableEnvironments.join(", ")}`
              : ""}
            . Update those servers to see their usage.
          </Text>
        ) : null}
        {usage?.trackingSince ? (
          <>
            <Text className="text-sm font-t3-medium text-foreground">
              {formatCount(total.requests)} requests · {formatPromptSuggestionCost(total)} API
              estimate
            </Text>
            <Text className="text-xs text-foreground-muted">
              {formatCount(total.generated)} generated · {formatCount(total.failed)} failed ·{" "}
              {formatCount(total.incomplete)} incomplete
            </Text>
            <Text className="text-xs text-foreground-muted">
              Average per priced request: {formatPromptSuggestionAverageCost(total)} API estimate.
            </Text>
            <Text className="text-xs text-foreground-muted">
              {total.requests > 0 && total.usageReportedRequests === 0
                ? "Tokens unknown"
                : `${formatCount(promptSuggestionTotalTokens(total.totals))} tokens${total.usageReportedRequests < total.requests ? " (partial)" : ""}`}
              . Token usage reported for {formatCount(total.usageReportedRequests)} of{" "}
              {formatCount(total.requests)} requests; cost unknown for{" "}
              {formatCount(total.unpricedRequests)} requests. Missing usage is unknown, not zero or
              free.
            </Text>
            {usage.rows.length === 0 ? (
              <Text className="text-sm text-foreground-muted">
                No tracked suggestions in this window.
              </Text>
            ) : (
              usage.rows.map((row) => (
                <View
                  key={`${row.provider}:${row.model}`}
                  className="gap-1 border-t border-outline-variant pt-3"
                >
                  <Text className="text-sm font-t3-medium text-foreground">
                    {PROVIDER_LABEL[row.provider]} · {row.model}
                  </Text>
                  <Text className="text-xs text-foreground-muted">
                    {formatCount(row.requests)} requests · {formatCount(row.generated)} generated ·{" "}
                    {formatCount(row.failed)} failed · {formatCount(row.incomplete)} incomplete
                  </Text>
                  <Text className="text-sm text-foreground">
                    {formatPromptSuggestionCost(row)} API estimate
                  </Text>
                  <Text className="text-xs text-foreground-muted">
                    {row.usageReportedRequests === 0
                      ? "Tokens unknown"
                      : `${formatCount(promptSuggestionTotalTokens(row.totals))} tokens${row.usageReportedRequests < row.requests ? " (partial)" : ""} · ${formatCount(row.totals.uncachedInputTokens)} input · ${formatCount(row.totals.cachedInputTokens)} cached · ${formatCount(row.totals.cacheCreationTokens)} cache write · ${formatCount(row.totals.outputTokens)} output`}
                  </Text>
                </View>
              ))
            )}
          </>
        ) : null}
      </View>
    </SettingsSection>
  );
}
