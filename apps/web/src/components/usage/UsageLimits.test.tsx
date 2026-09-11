import { ProviderDriverKind } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { LimitWindows } from "./UsageLimits";

vi.mock("../../hooks/useSettings", () => ({
  usePrimarySettings: (select: (settings: { timestampFormat: string }) => string) =>
    select({ timestampFormat: "relative" }),
}));

vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ render, children }: { render: ReactNode; children?: ReactNode }) => (
    <div>
      {render}
      {children}
    </div>
  ),
}));

const windows = [
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
    resetsAt: "2099-01-04T00:00:00.000Z",
  },
  {
    id: "seven_day_fable",
    kind: "weekly" as const,
    label: "Weekly · Fable",
    usedPercent: 0,
    resetsAt: "2099-01-04T00:00:00.000Z",
  },
];

describe("LimitWindows", () => {
  it("keeps stacked popover labels fully readable", () => {
    const markup = renderToStaticMarkup(
      <LimitWindows
        stack
        driver={ProviderDriverKind.make("claudeAgent")}
        windows={windows}
        now={Date.parse("2026-09-11T00:00:00.000Z")}
      />,
    );

    expect(markup).toContain("Session");
    expect(markup).toContain("Weekly");
    expect(markup).toContain("Weekly · Fable");
    expect(markup).toContain("100% left");
    expect(markup).toContain("82% left");
    expect(markup).toContain("resets in");
    expect(markup).not.toContain("W...");
    expect(markup).not.toContain("Wee...");
  });

  it("keeps compact banner labels fully readable", () => {
    const markup = renderToStaticMarkup(
      <LimitWindows
        compact
        driver={ProviderDriverKind.make("codex")}
        windows={windows}
        now={Date.parse("2026-09-11T00:00:00.000Z")}
      />,
    );

    expect(markup).toContain("Weekly · Fable");
    expect(markup).not.toContain("W...");
  });

  it("shows DeepSeek leftover as an amount instead of a percent bar", () => {
    const markup = renderToStaticMarkup(
      <LimitWindows
        stack
        driver={ProviderDriverKind.make("opencode")}
        windows={[
          {
            id: "deepseek_balance",
            kind: "other",
            label: "Top-up · DeepSeek",
            usedPercent: 0,
            remainingAmount: "110.00",
            remainingCurrency: "CNY",
            scope: "deepseek",
          },
        ]}
        now={Date.parse("2026-09-11T00:00:00.000Z")}
      />,
    );

    expect(markup).toContain("Top-up · DeepSeek");
    expect(markup).toContain("¥110.00 left");
    expect(markup).not.toContain("% left");
    expect(markup).not.toContain('role="img"');
  });
});
