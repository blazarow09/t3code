import { useState } from "react";
import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  formatResetsIn,
  leftoverRemainingText,
  leftoverUsageLabel,
  primaryUsageWindow,
  type LeftoverUsage,
} from "@t3tools/shared/usageLimits";

import { Button } from "../ui/button";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { LimitWindows } from "../usage/UsageLimits";
import {
  composerUsageCircleUsedPercent,
  formatContextWindowCompactionMessage,
} from "./ContextWindowMeter.logic";
import { Minimize2Icon } from "lucide-react";
import { composerFloatingLayerProps } from "./composerEventScope";

export type ComposerLeftoverUsage = LeftoverUsage;

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

function UsageCircle({
  usedPercent,
  color,
}: {
  readonly usedPercent: number;
  readonly color: string;
}) {
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - usedPercent / 100);
  return (
    <span className="relative flex size-5 items-center justify-center">
      <svg
        viewBox="0 0 24 24"
        className="-rotate-90 absolute inset-0 size-full transform-gpu mx-0!"
        aria-hidden="true"
      >
        <circle
          cx="12"
          cy="12"
          r={radius}
          fill="none"
          stroke="color-mix(in oklab, var(--color-muted-foreground) 24%, transparent)"
          strokeWidth="3"
        />
        <circle
          cx="12"
          cy="12"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          className="transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none"
        />
      </svg>
    </span>
  );
}

function ContextWindowSummary({
  usage,
  compact = false,
}: {
  readonly usage: ContextWindowSnapshot;
  readonly compact?: boolean;
}) {
  const usedPercentage = formatPercentage(usage.usedPercentage);
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const usageColor =
    normalizedPercentage > 90
      ? "var(--color-error)"
      : "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <div className="font-medium text-muted-foreground text-xs">Context window</div>
        {usage.maxTokens !== null && usedPercentage ? (
          <div className="text-secondary-label text-[11px] tabular-nums">
            <span>{usedPercentage}</span>
            <span className="mx-1">·</span>
            <span>
              {formatContextWindowTokens(usage.usedTokens)}/
              {formatContextWindowTokens(usage.maxTokens ?? null)}
            </span>
          </div>
        ) : (
          <div className="text-secondary-label text-[11px] tabular-nums">
            {formatContextWindowTokens(usage.usedTokens)}
          </div>
        )}
      </div>
      {usage.maxTokens !== null && !compact ? (
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(normalizedPercentage)}
          aria-label="Context window usage"
        >
          <div
            className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
            style={{ width: `${normalizedPercentage}%`, backgroundColor: usageColor }}
          />
        </div>
      ) : null}
    </div>
  );
}

function usageMeterAriaLabel(input: {
  readonly leftoverWindow: ServerProviderUsageWindow | null;
  readonly leftoverNow: number;
  readonly contextUsedPercentage: string | null;
  readonly contextUsedTokens: number | null;
  readonly contextMaxTokens: number | null;
}): string {
  if (input.leftoverWindow) {
    return leftoverUsageLabel(input.leftoverWindow, input.leftoverNow);
  }
  if (input.contextMaxTokens !== null && input.contextUsedPercentage) {
    return `Context window ${input.contextUsedPercentage} used`;
  }
  if (input.contextUsedTokens !== null) {
    return `Context window ${formatContextWindowTokens(input.contextUsedTokens)} tokens used`;
  }
  return "Usage";
}

export function ContextWindowMeter(props: {
  usage?: ContextWindowSnapshot | null;
  leftover?: ComposerLeftoverUsage | null;
  leftoverModelHint?: string | null | readonly (string | null | undefined)[];
  modelDisplayName?: string | null;
  onCompact?: (() => void) | undefined;
  compactDisabled?: boolean | undefined;
  compactDisabledReason?: string | null | undefined;
}) {
  const { usage = null, leftover = null, leftoverModelHint, modelDisplayName, onCompact } = props;
  const [detailOpen, setDetailOpen] = useState(false);
  const [now] = useState(() => Date.now());
  const leftoverWindow = leftover ? primaryUsageWindow(leftover.windows, leftoverModelHint) : null;
  const usedPercent =
    composerUsageCircleUsedPercent({
      leftoverUsedPercent: leftoverWindow?.usedPercent ?? null,
      contextUsedPercentage: usage?.usedPercentage ?? null,
    }) ?? 0;
  const isOverloaded = usedPercent > 90;
  const usageColor = isOverloaded
    ? "var(--color-error)"
    : "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";
  const contextUsedPercentage = formatPercentage(usage?.usedPercentage ?? null);
  const ariaLabel = usageMeterAriaLabel({
    leftoverWindow,
    leftoverNow: now,
    contextUsedPercentage,
    contextUsedTokens: usage?.usedTokens ?? null,
    contextMaxTokens: usage?.maxTokens ?? null,
  });
  const totalProcessedTokens = usage?.totalProcessedTokens ?? null;
  const showTotalProcessed = totalProcessedTokens !== null && totalProcessedTokens > 0;

  return (
    <Popover open={detailOpen} onOpenChange={setDetailOpen}>
      <Tooltip disabled={detailOpen}>
        <PopoverTrigger
          render={
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost-muted"
                  className="size-7 rounded-full hover:text-muted-foreground data-pressed:text-muted-foreground"
                  aria-label={ariaLabel}
                  aria-expanded={detailOpen}
                  data-composer-usage-meter="true"
                >
                  <UsageCircle usedPercent={usedPercent} color={usageColor} />
                </Button>
              }
            />
          }
        />
        <TooltipPopup side="top" className="max-w-80 text-left whitespace-normal">
          <div className="flex flex-col gap-1.5 py-0.5">
            {leftover?.windows.map((window) => {
              const resetsIn = formatResetsIn(window, now);
              return (
                <div key={window.id} className="flex min-w-0 flex-col gap-0.5">
                  <div className="flex items-start justify-between gap-3">
                    <span className="min-w-0 text-pretty font-medium">{window.label}</span>
                    <span className="shrink-0 tabular-nums text-secondary-label">
                      {leftoverRemainingText(window)}
                    </span>
                  </div>
                  {resetsIn ? (
                    <div className="text-secondary-label">
                      {resetsIn.charAt(0).toUpperCase() + resetsIn.slice(1)}
                    </div>
                  ) : null}
                </div>
              );
            })}
            {usage ? <ContextWindowSummary usage={usage} compact /> : null}
          </div>
        </TooltipPopup>
      </Tooltip>
      <PopoverPopup
        {...composerFloatingLayerProps}
        side="top"
        align="end"
        viewportClassName="p-0"
        className="w-80 max-w-[min(22rem,var(--available-width,22rem))] text-left whitespace-normal"
      >
        <div className="flex flex-col gap-3 p-[var(--floating-content-inset)]">
          {usage ? (
            <div className="flex flex-col gap-2">
              <ContextWindowSummary usage={usage} />
              {showTotalProcessed ? (
                <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
                  <span className="text-secondary-label">Total processed</span>
                  <span className="font-medium tabular-nums text-secondary-label">
                    {formatContextWindowTokens(totalProcessedTokens)}
                  </span>
                </div>
              ) : null}
              {usage.compactsAutomatically ? (
                <div className="text-pretty text-secondary-label text-[11px] font-medium">
                  {formatContextWindowCompactionMessage(
                    modelDisplayName,
                    usage.autoCompactThreshold,
                  )}
                </div>
              ) : null}
            </div>
          ) : null}
          {leftover && leftover.windows.length > 0 ? (
            <div className="flex flex-col gap-2">
              <div className="font-medium text-muted-foreground text-xs">
                {leftover.plan ? `Plan usage · ${leftover.plan}` : "Plan usage limits"}
              </div>
              <LimitWindows stack driver={leftover.driver} windows={leftover.windows} now={now} />
            </div>
          ) : null}
          {onCompact ? (
            <>
              <Button
                size="xs"
                variant="outline"
                className="w-full justify-center"
                disabled={props.compactDisabled}
                onClick={onCompact}
              >
                <Minimize2Icon aria-hidden="true" />
                Compact context
              </Button>
              {props.compactDisabled && props.compactDisabledReason ? (
                <div className="text-pretty text-secondary-label text-[11px]">
                  {props.compactDisabledReason}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/** Holds the meter's footprint while a thread's activities are still loading. */
export function ContextWindowMeterPlaceholder() {
  return <span aria-hidden="true" className="size-7 shrink-0" />;
}
