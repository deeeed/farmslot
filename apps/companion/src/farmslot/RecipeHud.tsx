import React, { useState } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RecipeHud as SharedRecipeHud, type RecipeHudProps } from '@farmslot/adapter-rn/recipe-hud';

export type {
  FarmslotRecipeHudState,
  FarmslotRecipeHudStatus,
  FarmslotRecipeHudStyles,
  FarmslotRecipeHudText,
  RecipeHudOptions,
  RecipeHudOverlayProps,
  RecipeHudProps,
} from '@farmslot/adapter-rn/recipe-hud';
export { useRecipeHudState } from '@farmslot/adapter-rn/recipe-hud';

// Companion uses the default 49-point bottom tab bar, excluding the inset.
const TAB_BAR_HEIGHT = 49;
const HUD_MARGIN = 4;

export function RecipeHud(props: Readonly<RecipeHudProps>): React.ReactElement | null {
  const insets = useSafeAreaInsets();
  const [height, setHeight] = useState(0);
  // Keep a short HUD in the safe-area footer as on main. Two-line/error panels
  // that cannot fit move above the bottom controls, retaining their full bounds.
  const bottom =
    height <= insets.bottom - HUD_MARGIN * 2
      ? Math.max(HUD_MARGIN, (insets.bottom - height) / 2)
      : insets.bottom + TAB_BAR_HEIGHT + HUD_MARGIN;
  const placement = props.state?.position === 'top' ? { top: insets.top + HUD_MARGIN } : { bottom };
  return (
    <SharedRecipeHud
      {...props}
      styles={{ ...props.styles, container: [placement, props.styles?.container] }}
      onLayout={(event) => {
        setHeight(event.nativeEvent.layout.height);
        props.onLayout?.(event);
      }}
    />
  );
}
