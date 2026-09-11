import { EventId, ProviderDriverKind, TurnId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { deriveLatestContextWindowSnapshot } from "~/lib/contextWindow";
import { ContextWindowMeter } from "./ContextWindowMeter";

vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverPopup: ({ children }: { children: ReactNode }) => (
    <div data-usage-detail="true">{children}</div>
  ),
  PopoverTrigger: ({ render }: { render: ReactNode }) => <div>{render}</div>,
}));

vi.mock("../usage/UsageLimits", () => ({
  LimitWindows: ({ windows }: { windows: ReadonlyArray<{ readonly label: string }> }) => (
    <div>{windows.map((window) => window.label).join(" ")}</div>
  ),
}));

vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipPopup: ({ children }: { children: ReactNode }) => (
    <div data-usage-tooltip="true">{children}</div>
  ),
  TooltipTrigger: ({ render, children }: { render: ReactNode; children?: ReactNode }) => (
    <div>
      {render}
      {children}
    </div>
  ),
}));

const usage = deriveLatestContextWindowSnapshot([
  {
    id: EventId.make("activity-1"),
    tone: "info",
    kind: "context-window.updated",
    summary: "Context updated",
    payload: { usedTokens: 100_000, maxTokens: 1_000_000 },
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-08-24T12:00:00.000Z",
  },
]);

if (!usage) {
  throw new Error("The context window test fixture did not produce a snapshot.");
}

const leftover = {
  driver: ProviderDriverKind.make("claudeAgent"),
  plan: "Max 5x",
  windows: [
    {
      id: "five_hour",
      kind: "session" as const,
      label: "Session",
      usedPercent: 0,
      windowDurationMins: 300,
      resetsAt: "2099-01-01T00:00:00.000Z",
    },
    {
      id: "seven_day",
      kind: "weekly" as const,
      label: "Weekly",
      usedPercent: 18,
    },
    {
      id: "seven_day_fable",
      kind: "weekly" as const,
      label: "Weekly · Fable",
      usedPercent: 0,
    },
  ],
};

describe("ContextWindowMeter", () => {
  it("summarizes leftover usage and context on hover, and lists the windows in the detail", () => {
    const markup = renderToStaticMarkup(
      <ContextWindowMeter usage={usage} leftover={leftover} onCompact={() => {}} />,
    );

    expect(markup).toContain('data-composer-usage-meter="true"');
    expect(markup).toContain("100% left");
    expect(markup).toContain("Context window");
    expect(markup).toContain("Plan usage · Max 5x");
    expect(markup).toContain("Weekly");
    expect(markup).toContain("Weekly · Fable");
    expect(markup).toContain("Compact context");
    expect(markup).toContain('aria-label="100% of Session left.');
  });

  it("shows context-only usage when the provider has no leftover windows", () => {
    const markup = renderToStaticMarkup(<ContextWindowMeter usage={usage} />);

    expect(markup).toContain("Context window");
    expect(markup).toContain("10%");
    expect(markup).not.toContain("Plan usage");
    expect(markup).not.toContain("Compact context");
  });

  it("explains why the compact action is disabled", () => {
    const markup = renderToStaticMarkup(
      <ContextWindowMeter
        leftover={leftover}
        onCompact={() => {}}
        compactDisabled
        compactDisabledReason="Send or clear your draft before compacting"
      />,
    );

    expect(markup).toContain('disabled=""');
    expect(markup).toContain(">Send or clear your draft before compacting<");
    expect(markup).not.toContain('aria-label="Send or clear your draft before compacting"');
  });

  it("shows DeepSeek leftover as a remaining amount instead of a percent", () => {
    const markup = renderToStaticMarkup(
      <ContextWindowMeter
        leftover={{
          driver: ProviderDriverKind.make("opencode"),
          windows: [
            {
              id: "deepseek_balance",
              kind: "other",
              label: "Top-up · DeepSeek",
              usedPercent: 0,
              remainingAmount: "12.50",
              remainingCurrency: "USD",
              scope: "deepseek",
            },
          ],
        }}
        leftoverModelHint="deepseek/deepseek-chat"
      />,
    );

    expect(markup).toContain("$12.50 left");
    expect(markup).toContain('aria-label="$12.50 of Top-up · DeepSeek left"');
    expect(markup).not.toContain("% of Top-up");
  });
});
