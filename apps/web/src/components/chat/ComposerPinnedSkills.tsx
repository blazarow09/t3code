import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";
import type { ServerProviderSkill } from "@t3tools/contracts";
import { PinIcon } from "lucide-react";
import { memo } from "react";

import { Button } from "../ui/button";
import { Menu, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";

export const ComposerPinnedSkills = memo(function ComposerPinnedSkills(props: {
  skills: readonly ServerProviderSkill[];
  disabled: boolean;
  onApply: (skill: ServerProviderSkill) => void;
}) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(props.disabled);
  if (props.skills.length === 0) return null;
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        openOnHover
        delay={80}
        closeDelay={150}
        render={
          <Button
            variant="glass"
            size="icon-xs"
            disabled={props.disabled}
            aria-label={`Pinned skills (${props.skills.length})`}
            data-composer-pinned-skills="true"
          />
        }
      >
        <PinIcon className="size-3" />
      </MenuTrigger>
      <MenuPopup side="top" align="start" sideOffset={6} {...composerFloatingLayerProps}>
        <MenuGroupLabel>Pinned skills</MenuGroupLabel>
        {props.skills.map((skill) => (
          <MenuItem
            key={skill.name}
            title={skill.shortDescription ?? skill.description ?? undefined}
            onClick={() => props.onApply(skill)}
          >
            {formatProviderSkillDisplayName(skill)}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
});
