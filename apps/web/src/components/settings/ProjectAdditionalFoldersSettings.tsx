import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useState } from "react";

import { readLocalApi } from "../../localApi";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/**
 * Folders outside the project root that Claude, Codex and OpenCode may also
 * read and edit. Paths belong to one machine, so each checkout edits its own.
 */
export function ProjectAdditionalFoldersSettings({
  member,
  showEnvironmentLabel,
}: {
  member: SidebarProjectGroupMember;
  showEnvironmentLabel: boolean;
}) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const [draft, setDraft] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const folders = member.additionalDirectories ?? [];
  const canPickFolder =
    member.environmentId === primaryEnvironmentId &&
    typeof window !== "undefined" &&
    window.desktopBridge !== undefined;

  const saveFolders = useCallback(
    async (additionalDirectories: ReadonlyArray<string>) => {
      setIsSaving(true);
      const result = await updateProject({
        environmentId: member.environmentId,
        input: { projectId: member.id, additionalDirectories },
      });
      setIsSaving(false);
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to update additional folders",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return false;
      }
      return true;
    },
    [member.environmentId, member.id, updateProject],
  );

  const addFolder = useCallback(
    async (rawPath: string) => {
      const folder = rawPath.trim();
      if (!folder || folders.includes(folder)) return;
      if (await saveFolders([...folders, folder])) setDraft("");
    },
    [folders, saveFolders],
  );

  const pickFolder = useCallback(async () => {
    const api = readLocalApi();
    if (!api) return;
    const picked = await settlePromise(() => api.dialogs.pickFolder());
    if (picked._tag === "Failure" || !picked.value) return;
    await addFolder(picked.value);
  }, [addFolder]);

  return (
    <SettingsSection
      title={
        showEnvironmentLabel
          ? `Additional folders · ${member.environmentLabel ?? "Environment"}`
          : "Additional folders"
      }
    >
      {folders.map((folder) => (
        <SettingsRow
          key={folder}
          title={folder}
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={isSaving}
              aria-label={`Remove folder ${folder}`}
              onClick={() => void saveFolders(folders.filter((entry) => entry !== folder))}
            >
              Remove
            </Button>
          }
        />
      ))}
      <SettingsRow
        title="Add folder"
        description="Claude, Codex and OpenCode can also read and edit these folders. Diffs and restore points cover only the project folder."
        control={
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <Input
              size="sm"
              className="w-full sm:w-64"
              aria-label="Additional folder path"
              placeholder="Absolute folder path"
              value={draft}
              disabled={isSaving}
              onChange={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void addFolder(draft);
              }}
            />
            {canPickFolder ? (
              <Button
                size="sm"
                variant="outline"
                type="button"
                disabled={isSaving}
                onClick={() => void pickFolder()}
              >
                Browse
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                type="button"
                disabled={isSaving || draft.trim().length === 0}
                onClick={() => void addFolder(draft)}
              >
                Add
              </Button>
            )}
          </div>
        }
      />
    </SettingsSection>
  );
}
