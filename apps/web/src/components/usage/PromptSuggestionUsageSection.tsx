import type { UsageProviderKind } from "@t3tools/contracts";
import {
  formatPromptSuggestionAverageCost,
  formatPromptSuggestionCost,
  promptSuggestionTotalTokens,
  sumPromptSuggestionUsage,
  type MergedPromptSuggestionUsage,
} from "@t3tools/shared/usageMerge";
import { formatCount } from "@t3tools/shared/usageFormat";
import { PROVIDER_PRESENTATION } from "./usageProviders";

export function PromptSuggestionUsageSection({
  usage,
  hiddenProviders,
}: {
  readonly usage: MergedPromptSuggestionUsage | undefined;
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
}) {
  const rows = usage?.rows.filter((row) => !hiddenProviders.has(row.provider)) ?? [];
  const total = sumPromptSuggestionUsage(rows);
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-foreground">Prompt suggestions</h2>
      <p className="text-xs text-muted-foreground">
        Tracked from this update onwards
        {usage?.trackingSince
          ? `; all selected ledgers track since ${new Date(usage.trackingSince).toLocaleDateString()}`
          : ""}
        . API-equivalent estimates are not subscription charges. These requests stay separate from
        transcript totals, which may already include them.
      </p>
      {!usage || usage.unavailableEnvironments.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Suggestion tracking is unavailable
          {usage?.unavailableEnvironments.length
            ? ` for ${usage.unavailableEnvironments.join(", ")}`
            : ""}
          . Update those servers to see their usage.
        </p>
      ) : null}
      {usage?.trackingSince ? (
        <>
          <p className="text-sm tabular-nums">
            {formatCount(total.requests)} requests · {formatCount(total.generated)} generated ·{" "}
            {formatCount(total.failed)} failed · {formatCount(total.incomplete)} incomplete
            <span className="text-muted-foreground">
              {" "}
              ·{" "}
              {total.requests > 0 && total.usageReportedRequests === 0
                ? "Tokens unknown"
                : `${formatCount(promptSuggestionTotalTokens(total.totals))} tokens${total.usageReportedRequests < total.requests ? " (partial)" : ""}`}{" "}
              · {formatPromptSuggestionCost(total)} API estimate
            </span>
          </p>
          <p className="text-xs text-muted-foreground">
            Average per priced request: {formatPromptSuggestionAverageCost(total)} API estimate.{" "}
            Token usage reported for {formatCount(total.usageReportedRequests)} of{" "}
            {formatCount(total.requests)} requests; cost unknown for{" "}
            {formatCount(total.unpricedRequests)} requests. Missing usage is unknown, not zero or
            free.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm tabular-nums">
              <thead>
                <tr className="border-b border-border text-right text-xs text-muted-foreground">
                  {[
                    "Provider / model",
                    "Requests",
                    "Generated",
                    "Failed / incomplete",
                    "Input",
                    "Cached",
                    "Cache write",
                    "Output",
                    "Total tokens",
                    "API estimate",
                  ].map((label, index) => (
                    <th
                      key={label}
                      className={
                        index === 0
                          ? "py-2 pr-3 text-left font-normal"
                          : "whitespace-nowrap py-2 pl-4 font-normal"
                      }
                    >
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="py-6 text-center text-muted-foreground">
                      No tracked suggestions in this window.
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => (
                    <tr
                      key={`${row.provider}:${row.model}`}
                      className="border-b border-border/50 text-right"
                    >
                      <td className="py-3 pr-3 text-left">
                        <div>{row.model}</div>
                        <div className="text-xs text-muted-foreground">
                          {PROVIDER_PRESENTATION[row.provider].label}
                        </div>
                      </td>
                      <td className="py-3 pl-4">{formatCount(row.requests)}</td>
                      <td className="py-3 pl-4">{formatCount(row.generated)}</td>
                      <td className="py-3 pl-4">
                        {formatCount(row.failed)} / {formatCount(row.incomplete)}
                      </td>
                      {Object.entries({
                        input: row.totals.uncachedInputTokens,
                        cached: row.totals.cachedInputTokens,
                        cacheWrite: row.totals.cacheCreationTokens,
                        output: row.totals.outputTokens,
                        total: promptSuggestionTotalTokens(row.totals),
                      }).map(([category, tokens]) => (
                        <td key={category} className="whitespace-nowrap py-3 pl-4">
                          {row.usageReportedRequests === 0
                            ? "Unknown"
                            : `${formatCount(tokens)}${row.usageReportedRequests < row.requests ? " (partial)" : ""}`}
                        </td>
                      ))}
                      <td className="whitespace-nowrap py-3 pl-4">
                        {formatPromptSuggestionCost(row)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}
