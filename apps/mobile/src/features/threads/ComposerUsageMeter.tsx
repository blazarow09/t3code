import {
  leftoverUsageLabel,
  primaryUsageWindow,
  type LeftoverUsage,
} from "@t3tools/shared/usageLimits";
import { Pressable, View } from "react-native";
import Svg, { Circle } from "react-native-svg";

import { useUniwindTheme } from "../../lib/useUniwindTheme";

const SIZE = 20;
const RADIUS = 7.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function ComposerUsageMeter(props: {
  readonly leftover: LeftoverUsage;
  readonly modelHint?: string | null | readonly (string | null | undefined)[];
  readonly onPress: () => void;
}) {
  const colors = useUniwindTheme();
  const window = primaryUsageWindow(props.leftover.windows, props.modelHint);
  if (!window) return null;
  const usedPercent = Math.max(0, Math.min(100, window.usedPercent));
  const dashOffset = CIRCUMFERENCE * (1 - usedPercent / 100);
  const stroke =
    usedPercent > 90 ? colors["--color-danger-foreground"] : colors["--color-foreground-muted"];
  return (
    <Pressable
      accessibilityLabel={leftoverUsageLabel(window, Date.now())}
      accessibilityRole="button"
      hitSlop={8}
      onPress={props.onPress}
      className="size-8 items-center justify-center active:opacity-60"
    >
      <View className="size-5 items-center justify-center">
        <Svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
          <Circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            stroke={colors["--color-foreground-tertiary"]}
            strokeOpacity={0.35}
            strokeWidth={2.5}
          />
          <Circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            stroke={stroke}
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeDasharray={`${CIRCUMFERENCE} ${CIRCUMFERENCE}`}
            strokeDashoffset={dashOffset}
            transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
          />
        </Svg>
      </View>
    </Pressable>
  );
}
