import { normalizeProjectPathForComparison } from "@t3tools/shared/path";

/** Checkout the custom sync skill and its helper script operate on. */
export const CUSTOM_SYNC_REPO_ROOT = "D:\\Projects\\t3code";

/** OpenCode slug whose catalog name is DeepSeek V4.1 Flash. */
export const CUSTOM_SYNC_MODEL_SLUG = "deepseek/deepseek-flash";

export const CUSTOM_SYNC_MODEL_LABEL = "DeepSeek V4.1 Flash";

export const CUSTOM_SYNC_SKILL_NAME = "t3code-custom-sync";

export const CUSTOM_SYNC_THREAD_TITLE = "Sync custom build";

/**
 * Composer skill mentions are `$name`. OpenCode loads the skill from that
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
  const ready = providers.filter(
    (provider) =>
      provider.driver === "opencode" &&
      provider.enabled &&
      provider.installed &&
      provider.availability !== "unavailable",
  );
  return (
    ready.find((provider) =>
      provider.models.some((model) => model.slug === CUSTOM_SYNC_MODEL_SLUG),
    ) ??
    ready[0] ??
    null
  );
}
