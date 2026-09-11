import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOs from "node:os";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { describe, expect } from "vite-plus/test";

import {
  DEEPSEEK_BALANCE_WINDOW_ID,
  DEEPSEEK_BALANCE_WINDOW_LABEL,
  DEEPSEEK_USAGE_SCOPE,
} from "@t3tools/shared/usageLimits";

import {
  attachOpenCodeDeepSeekUsageLimits,
  DEEPSEEK_BALANCE_URL,
  deepseekApiKeyFromAuthStore,
  deepseekApiKeyFromEnv,
  deepseekBalanceToUsageLimits,
  openCodeAuthJsonCandidatePaths,
  probeDeepSeekUsageLimits,
  resolveDeepSeekApiKey,
} from "./deepseekUsageLimits.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";

const checkedAt = "2026-09-11T12:00:00.000Z";

const balance = {
  is_available: true,
  balance_infos: [
    {
      currency: "CNY",
      total_balance: "110.00",
      granted_balance: "10.00",
      topped_up_balance: "100.00",
    },
  ],
};

const draft = {
  enabled: true,
  installed: true,
  checkedAt,
} as ServerProviderDraft;

describe("deepseekApiKeyFromEnv", () => {
  it("reads DEEPSEEK_API_KEY and ignores blanks", () => {
    expect(deepseekApiKeyFromEnv({ DEEPSEEK_API_KEY: " sk-test " })).toBe("sk-test");
    expect(deepseekApiKeyFromEnv({ DEEPSEEK_API_KEY: "   " })).toBeUndefined();
    expect(deepseekApiKeyFromEnv({})).toBeUndefined();
  });
});

describe("deepseekApiKeyFromAuthStore", () => {
  it("reads OpenCode's deepseek api entry and ignores other shapes", () => {
    expect(deepseekApiKeyFromAuthStore({ deepseek: { type: "api", key: "sk-opencode" } })).toBe(
      "sk-opencode",
    );
    expect(deepseekApiKeyFromAuthStore({ deepseek: { key: "sk-plain" } })).toBe("sk-plain");
    expect(
      deepseekApiKeyFromAuthStore({ deepseek: { type: "oauth", key: "token" } }),
    ).toBeUndefined();
    expect(
      deepseekApiKeyFromAuthStore({ openai: { type: "api", key: "sk-other" } }),
    ).toBeUndefined();
    expect(deepseekApiKeyFromAuthStore(null)).toBeUndefined();
  });
});

describe("openCodeAuthJsonCandidatePaths", () => {
  it.effect("prefers XDG_DATA_HOME, then ~/.local/share, then LOCALAPPDATA", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(
        openCodeAuthJsonCandidatePaths(path, {
          XDG_DATA_HOME: "/xdg/data",
          HOME: "/home/user",
          LOCALAPPDATA: "/win/local",
        }),
      ).toEqual([
        path.resolve(path.join("/xdg/data", "opencode", "auth.json")),
        path.resolve(path.join("/home/user", ".local", "share", "opencode", "auth.json")),
        path.resolve(path.join("/win/local", "opencode", "auth.json")),
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("deepseekBalanceToUsageLimits", () => {
  it("maps total remaining as an amount-scoped window and prefers USD", () => {
    expect(deepseekBalanceToUsageLimits(balance, checkedAt)).toEqual({
      checkedAt,
      windows: [
        {
          id: DEEPSEEK_BALANCE_WINDOW_ID,
          kind: "other",
          label: DEEPSEEK_BALANCE_WINDOW_LABEL,
          usedPercent: 0,
          remainingAmount: "110.00",
          remainingCurrency: "CNY",
          scope: DEEPSEEK_USAGE_SCOPE,
        },
      ],
    });
    expect(
      deepseekBalanceToUsageLimits(
        {
          is_available: true,
          balance_infos: [
            { currency: "CNY", total_balance: "10.00" },
            { currency: "USD", total_balance: "12.50" },
          ],
        },
        checkedAt,
      )?.windows[0],
    ).toMatchObject({ remainingAmount: "12.50", remainingCurrency: "USD", usedPercent: 0 });
  });

  it("marks an empty balance as spent without inventing a plan percent", () => {
    expect(
      deepseekBalanceToUsageLimits(
        {
          is_available: false,
          balance_infos: [{ currency: "USD", total_balance: "0.00" }],
        },
        checkedAt,
      )?.windows[0],
    ).toMatchObject({ remainingAmount: "0.00", remainingCurrency: "USD", usedPercent: 100 });
  });

  it("returns nothing for an unreadable payload", () => {
    expect(deepseekBalanceToUsageLimits({ error: "nope" }, checkedAt)).toBeUndefined();
    expect(deepseekBalanceToUsageLimits({ balance_infos: [] }, checkedAt)).toBeUndefined();
  });
});

describe("resolveDeepSeekApiKey", () => {
  it.effect("prefers the instance env over OpenCode's auth store", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const dir = path.join(NodeOs.tmpdir(), `t3-deepseek-auth-${Date.now()}`);
      const authDir = path.join(dir, "opencode");
      yield* fileSystem.makeDirectory(authDir, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(authDir, "auth.json"),
        JSON.stringify({ deepseek: { type: "api", key: "sk-from-file" } }),
      );
      expect(
        yield* resolveDeepSeekApiKey({
          DEEPSEEK_API_KEY: "sk-from-env",
          XDG_DATA_HOME: dir,
        }),
      ).toBe("sk-from-env");
      expect(yield* resolveDeepSeekApiKey({ XDG_DATA_HOME: dir })).toBe("sk-from-file");
      expect(
        yield* resolveDeepSeekApiKey({
          OPENCODE_AUTH_CONTENT: JSON.stringify({
            deepseek: { type: "api", key: "sk-from-content" },
          }),
        }),
      ).toBe("sk-from-content");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("probeDeepSeekUsageLimits", () => {
  it.effect("GETs /user/balance with the bearer key and maps leftover", () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request.url);
          expect(request.headers.authorization).toBe("Bearer sk-test");
          return HttpClientResponse.fromWeb(request, Response.json(balance));
        }),
      );
      const limits = yield* probeDeepSeekUsageLimits({ apiKey: "sk-test", checkedAt }).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      expect(requests).toEqual([DEEPSEEK_BALANCE_URL]);
      expect(limits?.windows[0]?.remainingAmount).toBe("110.00");
    }),
  );

  it.effect("swallows a failed probe instead of inventing leftover", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response("nope", { status: 401 }))),
      );
      expect(
        yield* probeDeepSeekUsageLimits({ apiKey: "sk-bad", checkedAt }).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
        ),
      ).toBeUndefined();
    }),
  );
});

describe("attachOpenCodeDeepSeekUsageLimits", () => {
  it.effect("attaches leftover when OpenCode already has a DeepSeek key", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(balance))),
      );
      const next = yield* attachOpenCodeDeepSeekUsageLimits({
        draft,
        environment: { DEEPSEEK_API_KEY: "sk-test" },
        checkedAt,
      }).pipe(Effect.provideService(HttpClient.HttpClient, http));
      expect(next.usageLimits?.windows[0]?.id).toBe(DEEPSEEK_BALANCE_WINDOW_ID);
      expect(next.usageLimits?.windows[0]?.remainingAmount).toBe("110.00");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves a draft without a key unchanged", () =>
    Effect.gen(function* () {
      const next = yield* attachOpenCodeDeepSeekUsageLimits({
        draft,
        environment: {},
        checkedAt,
      });
      expect(next).toBe(draft);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
