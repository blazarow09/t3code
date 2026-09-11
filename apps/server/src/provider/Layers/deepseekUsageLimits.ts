/**
 * DeepSeek prepaid leftover. OpenCode has no native usage probe; the public
 * `GET /user/balance` read is an absolute CNY/USD remaining amount, not a
 * subscription percent. The key is whatever OpenCode or the instance already
 * has — never logged.
 *
 * @module provider/Layers/deepseekUsageLimits
 */
import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  DEEPSEEK_BALANCE_WINDOW_ID,
  DEEPSEEK_BALANCE_WINDOW_LABEL,
  DEEPSEEK_USAGE_SCOPE,
} from "@t3tools/shared/usageLimits";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { makeUsageLimits } from "../providerUsageLimits.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";

export const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
const DEEPSEEK_BALANCE_TIMEOUT = "5 seconds";

const DeepSeekBalanceInfo = Schema.Struct({
  currency: Schema.String,
  total_balance: Schema.String,
  granted_balance: Schema.optional(Schema.String),
  topped_up_balance: Schema.optional(Schema.String),
});

const DeepSeekBalanceResponse = Schema.Struct({
  is_available: Schema.optional(Schema.Boolean),
  balance_infos: Schema.Array(DeepSeekBalanceInfo),
});

const OpenCodeApiAuth = Schema.Struct({
  type: Schema.optional(Schema.String),
  key: Schema.String,
});

function trimmedKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/** Instance env wins; OpenCode also documents `DEEPSEEK_API_KEY`. */
export function deepseekApiKeyFromEnv(
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  return trimmedKey(environment.DEEPSEEK_API_KEY);
}

export function deepseekApiKeyFromAuthStore(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = (value as Record<string, unknown>)[DEEPSEEK_USAGE_SCOPE];
  const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(OpenCodeApiAuth)(entry));
  if (!decoded) return undefined;
  if (decoded.type !== undefined && decoded.type !== "api") return undefined;
  return trimmedKey(decoded.key);
}

/**
 * OpenCode reads `Global.Path.data/auth.json` via xdg-basedir. Docs pin
 * `~/.local/share/opencode` even on Windows; xdg-basedir itself may use
 * LOCALAPPDATA. Try every candidate; first readable key wins.
 */
export function openCodeAuthJsonCandidatePaths(
  path: Path.Path,
  environment: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (base: string | undefined) => {
    const trimmed = base?.trim();
    if (!trimmed) return;
    const candidate = path.resolve(path.join(trimmed, "opencode", "auth.json"));
    if (seen.has(candidate)) return;
    seen.add(candidate);
    out.push(candidate);
  };
  push(environment.XDG_DATA_HOME);
  const home = environment.HOME ?? environment.USERPROFILE;
  if (home?.trim()) push(path.join(home.trim(), ".local", "share"));
  push(environment.LOCALAPPDATA);
  return out;
}

function pickBalanceInfo(
  infos: ReadonlyArray<typeof DeepSeekBalanceInfo.Type>,
): typeof DeepSeekBalanceInfo.Type | undefined {
  return (
    infos.find((info) => info.currency.trim().toUpperCase() === "USD") ??
    infos.find((info) => info.total_balance.trim().length > 0)
  );
}

function usedPercentFromRemaining(amount: string, isAvailable: boolean | undefined): number {
  const parsed = Number(amount);
  if (Number.isFinite(parsed)) return parsed > 0 ? 0 : 100;
  return isAvailable === false ? 100 : 0;
}

/** Map a `/user/balance` payload onto one scoped leftover window. */
export function deepseekBalanceToUsageLimits(
  payload: unknown,
  checkedAt: string,
): ServerProviderUsageLimits | undefined {
  const decoded = Option.getOrUndefined(
    Schema.decodeUnknownOption(DeepSeekBalanceResponse)(payload),
  );
  if (!decoded) return undefined;
  const info = pickBalanceInfo(decoded.balance_infos);
  const remainingAmount = info?.total_balance.trim();
  if (!info || !remainingAmount) return undefined;
  const remainingCurrency = info.currency.trim().toUpperCase();
  const window: ServerProviderUsageWindow = {
    id: DEEPSEEK_BALANCE_WINDOW_ID,
    kind: "other",
    label: DEEPSEEK_BALANCE_WINDOW_LABEL,
    usedPercent: usedPercentFromRemaining(remainingAmount, decoded.is_available),
    remainingAmount,
    ...(remainingCurrency ? { remainingCurrency } : {}),
    scope: DEEPSEEK_USAGE_SCOPE,
  };
  return makeUsageLimits({ checkedAt, windows: [window] });
}

export const resolveDeepSeekApiKey = Effect.fn("resolveDeepSeekApiKey")(function* (
  environment: Readonly<Record<string, string | undefined>>,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fromEnv = deepseekApiKeyFromEnv(environment);
  if (fromEnv) return fromEnv;

  const fromContent = deepseekApiKeyFromAuthStore(
    (() => {
      const raw = environment.OPENCODE_AUTH_CONTENT?.trim();
      if (!raw) return undefined;
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return undefined;
      }
    })(),
  );
  if (fromContent) return fromContent;

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const candidate of openCodeAuthJsonCandidatePaths(path, environment)) {
    const raw = yield* fileSystem.readFileString(candidate).pipe(Effect.orElseSucceed(() => ""));
    if (!raw.trim()) continue;
    try {
      const key = deepseekApiKeyFromAuthStore(JSON.parse(raw) as unknown);
      if (key) return key;
    } catch {
      // Unreadable store is the same as a missing key.
    }
  }
  return undefined;
});

export const probeDeepSeekUsageLimits = Effect.fn("probeDeepSeekUsageLimits")(function* (input: {
  readonly apiKey: string;
  readonly checkedAt: string;
}): Effect.fn.Return<ServerProviderUsageLimits | undefined, never, HttpClient.HttpClient> {
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.get(DEEPSEEK_BALANCE_URL).pipe(
    HttpClientRequest.setHeader("Authorization", `Bearer ${input.apiKey}`),
  );
  const payload = yield* client.execute(request).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.json),
    Effect.timeout(DEEPSEEK_BALANCE_TIMEOUT),
    Effect.orElseSucceed(() => undefined),
  );
  return payload === undefined ? undefined : deepseekBalanceToUsageLimits(payload, input.checkedAt);
});

export const attachOpenCodeDeepSeekUsageLimits = Effect.fn("attachOpenCodeDeepSeekUsageLimits")(
  function* (input: {
    readonly draft: ServerProviderDraft;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly checkedAt: string;
  }): Effect.fn.Return<
    ServerProviderDraft,
    never,
    HttpClient.HttpClient | FileSystem.FileSystem | Path.Path
  > {
    if (!input.draft.enabled || !input.draft.installed) return input.draft;
    const apiKey = yield* resolveDeepSeekApiKey(input.environment);
    if (!apiKey) return input.draft;
    const usageLimits = yield* probeDeepSeekUsageLimits({
      apiKey,
      checkedAt: input.checkedAt,
    });
    if (!usageLimits) return input.draft;
    const existing = input.draft.usageLimits?.windows ?? [];
    if (existing.some((window) => window.id === DEEPSEEK_BALANCE_WINDOW_ID)) {
      return input.draft;
    }
    return {
      ...input.draft,
      usageLimits: makeUsageLimits({
        checkedAt: usageLimits.checkedAt,
        windows: [...existing, ...usageLimits.windows],
      }),
    };
  },
);
