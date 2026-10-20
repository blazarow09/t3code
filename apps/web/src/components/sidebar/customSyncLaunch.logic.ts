import { normalizeProjectPathForComparison } from "@t3tools/shared/path";

/** Checkout the custom sync skill and its helper script operate on. */
export const CUSTOM_SYNC_REPO_ROOT = "D:\\Projects\\t3code";

/** Codex model and effort used for custom sync chats. */
export const CUSTOM_SYNC_MODEL_SLUG = "gpt-6.1-sol";

export const CUSTOM_SYNC_MODEL_LABEL = "GPT-6.1 Sol (medium)";

export const CUSTOM_SYNC_MODEL_OPTIONS = [{ id: "reasoningEffort", value: "medium" }] as const;

export const CUSTOM_SYNC_SKILL_NAME = "t3code-custom-sync";

export const CUSTOM_SYNC_THREAD_TITLE = "Sync custom build";

/**
 * Composer skill mentions are `$name`. Codex loads the skill from that
 * token. The rest of the message is the job: rebase, keep custom changes,
 * and stop once the installer exists.
 */
export const CUSTOM_SYNC_PROMPT = [
  `$${CUSTOM_SYNC_SKILL_NAME}`,
  "",
  "Pull upstream into the custom branch, keep our custom changes, and build an installer that is ready to install. Stop before installing.",
].join("\n");

export interface CustomSyncProjectCandidate {
  readonly environmentId: string;
  readonly workspaceRoot: string;
}

export interface CustomSyncProviderCandidate {
  readonly instanceId: string;
  readonly driver: string;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly availability?: "available" | "unavailable" | undefined;
  readonly models: ReadonlyArray<{ readonly slug: string }>;
}

export function selectCustomSyncProject<T extends CustomSyncProjectCandidate>(
  projects: ReadonlyArray<T>,
  primaryEnvironmentId: string | null,
  repoRoot: string = CUSTOM_SYNC_REPO_ROOT,
): T | null {
  const wanted = normalizeProjectPathForComparison(repoRoot);
  if (wanted.length === 0) return null;
  const matches = projects.filter(
    (project) => normalizeProjectPathForComparison(project.workspaceRoot) === wanted,
  );
  if (matches.length === 0) return null;
  return matches.find((project) => project.environmentId === primaryEnvironmentId) ?? matches[0]!;
}

export function selectCustomSyncProvider<T extends CustomSyncProviderCandidate>(
  providers: ReadonlyArray<T>,
): T | null {
  return (
    providers.find(
      (provider) =>
        provider.driver === "codex" &&
        provider.enabled &&
        provider.installed &&
        provider.availability !== "unavailable" &&
        provider.models.some((model) => model.slug === CUSTOM_SYNC_MODEL_SLUG),
    ) ?? null
  );
}
