import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { createModelSelection } from "@t3tools/shared/model";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type EnvironmentId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useRef, useState } from "react";

import { inferProjectTitleFromPath } from "../../lib/projectPaths";
import { newMessageId, newProjectId, newThreadId } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readProjects, waitForProject } from "../../state/entities";
import { environmentServerConfigsAtom } from "../../state/server";
import { projectEnvironment } from "../../state/projects";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  CUSTOM_SYNC_MODEL_LABEL,
  CUSTOM_SYNC_MODEL_OPTIONS,
  CUSTOM_SYNC_MODEL_SLUG,
  CUSTOM_SYNC_PROMPT,
  CUSTOM_SYNC_REPO_ROOT,
  CUSTOM_SYNC_THREAD_TITLE,
  selectCustomSyncProject,
  selectCustomSyncProvider,
} from "./customSyncLaunch.logic";

function commandErrorMessage(
  result: Parameters<typeof squashAtomCommandFailure>[0],
  fallback: string,
): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : fallback;
}

function reportSyncStartError(title: string, description: string) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description,
    }),
  );
}

export function useStartCustomSyncThread() {
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);

  const start = useCallback(async (): Promise<boolean> => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setPending(true);
    try {
      const project = await ensureCustomSyncProject({
        primaryEnvironmentId,
        createProject,
      });
      if (project === null) {
        return false;
      }

      const providers =
        appAtomRegistry.get(environmentServerConfigsAtom).get(project.environmentId)?.providers ??
        [];
      const provider = selectCustomSyncProvider(providers);
      if (provider === null) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Codex model is not available",
            description: `${CUSTOM_SYNC_MODEL_LABEL} requires an available Codex provider.`,
          }),
        );
        return false;
      }

      const environmentId = project.environmentId;
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      const modelSelection = createModelSelection(
        ProviderInstanceId.make(provider.instanceId),
        CUSTOM_SYNC_MODEL_SLUG,
        CUSTOM_SYNC_MODEL_OPTIONS,
      );
      const createResult = await createThread({
        environmentId,
        input: {
          threadId,
          projectId: project.id,
          title: CUSTOM_SYNC_THREAD_TITLE,
          modelSelection,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt,
        },
      });
      if (createResult._tag === "Failure") {
        if (!isAtomCommandInterrupted(createResult)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not start the sync chat",
              description: commandErrorMessage(createResult, "The new chat could not be created."),
            }),
          );
        }
        return false;
      }

      const startResult = await startThreadTurn({
        environmentId,
        input: {
          threadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: CUSTOM_SYNC_PROMPT,
            attachments: [],
          },
          modelSelection,
          titleSeed: CUSTOM_SYNC_THREAD_TITLE,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt,
        },
      });
      if (startResult._tag === "Failure") {
        await deleteThread({
          environmentId,
          input: { threadId },
        });
        if (!isAtomCommandInterrupted(startResult)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not start the sync chat",
              description: commandErrorMessage(startResult, "The first message could not be sent."),
            }),
          );
        }
        return false;
      }

      try {
        await navigate({
          to: "/$environmentId/$threadId",
          params: {
            environmentId,
            threadId,
          },
        });
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Sync chat started",
            description:
              error instanceof Error
                ? error.message
                : "The chat is in the sidebar. Open it from there.",
          }),
        );
      }
      return true;
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }, [createProject, createThread, deleteThread, navigate, primaryEnvironmentId, startThreadTurn]);

  return { pending, start };
}

async function ensureCustomSyncProject(input: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly createProject: (value: {
    readonly environmentId: EnvironmentId;
    readonly input: {
      readonly projectId: ReturnType<typeof newProjectId>;
      readonly title: string;
      readonly workspaceRoot: string;
      readonly createWorkspaceRootIfMissing: false;
      readonly defaultModelSelection: null;
    };
  }) => Promise<AtomCommandResult<unknown, unknown>>;
}): Promise<EnvironmentProject | null> {
  const existing = selectCustomSyncProject(readProjects(), input.primaryEnvironmentId);
  if (existing) return existing;
  if (input.primaryEnvironmentId === null) {
    reportSyncStartError(
      "t3code is not open",
      `This app is not connected, so ${CUSTOM_SYNC_REPO_ROOT} could not be added.`,
    );
    return null;
  }

  const projectId = newProjectId();
  const createResult = await input.createProject({
    environmentId: input.primaryEnvironmentId,
    input: {
      projectId,
      title: inferProjectTitleFromPath(CUSTOM_SYNC_REPO_ROOT),
      workspaceRoot: CUSTOM_SYNC_REPO_ROOT,
      createWorkspaceRootIfMissing: false,
      defaultModelSelection: null,
    },
  });
  if (createResult._tag === "Failure") {
    const raced = selectCustomSyncProject(readProjects(), input.primaryEnvironmentId);
    if (raced) return raced;
    if (!isAtomCommandInterrupted(createResult)) {
      reportSyncStartError(
        "Could not open t3code",
        commandErrorMessage(createResult, `Could not add ${CUSTOM_SYNC_REPO_ROOT}.`),
      );
    }
    return null;
  }

  try {
    return await waitForProject(scopeProjectRef(input.primaryEnvironmentId, projectId));
  } catch (error) {
    reportSyncStartError(
      "Could not open t3code",
      error instanceof Error ? error.message : `Could not add ${CUSTOM_SYNC_REPO_ROOT}.`,
    );
    return null;
  }
}
