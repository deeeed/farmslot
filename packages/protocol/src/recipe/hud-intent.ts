/** Display limits apply after font layout, never by cutting authored copy. */
export const HUD_INTENT_MAX_LINES = 2;
export const HUD_INTENT_LINE_HEIGHT = 16;
export const RECIPE_INTENT_WARN_LENGTH = 80;
export const RECIPE_INTENT_MAX_LENGTH = 120;
export const HUD_PANEL_BOUNDS = {
  native: { maxWidth: 360, maxHeight: 88 },
  card: { maxWidth: 360, maxHeight: 144 },
  bar: { maxWidth: 960, maxHeight: 144 },
} as const;

export type RecipeHudPlacement = 'top' | 'bottom';

/** Native renderers use the vertical part of the existing HUD display position. */
export function hudPlacement(display: unknown): RecipeHudPlacement | undefined {
  if (!display || typeof display !== 'object') return undefined;
  const position = (display as { position?: unknown }).position;
  if (position === 'top' || position === 'top-left' || position === 'top-right') return 'top';
  if (position === 'bottom' || position === 'bottom-left' || position === 'bottom-right')
    return 'bottom';
  return undefined;
}

/** Let the updated caption paint before the next capture or recorder stop. */
export function waitForHudPaint(nextFrame: (callback: () => void) => unknown): Promise<void> {
  return new Promise((resolve) => nextFrame(() => nextFrame(() => resolve())));
}

export function hudIntentDisplay(
  value: string | number | null | undefined,
  platform: keyof typeof HUD_PANEL_BOUNDS = 'card',
) {
  return {
    text: String(value ?? '')
      .replace(/\s+/gu, ' ')
      .trim(),
    panel: HUD_PANEL_BOUNDS[platform],
    nativeProps: {
      numberOfLines: HUD_INTENT_MAX_LINES,
      ellipsizeMode: 'tail' as const,
      allowFontScaling: false,
    },
    nativeStyle: {
      lineHeight: HUD_INTENT_LINE_HEIGHT,
      maxHeight: HUD_INTENT_LINE_HEIGHT * HUD_INTENT_MAX_LINES,
      fontSize: 12,
    },
    webStyle: {
      display: '-webkit-box',
      WebkitBoxOrient: 'vertical',
      WebkitLineClamp: String(HUD_INTENT_MAX_LINES),
      whiteSpace: 'normal',
      overflowWrap: 'anywhere',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      lineHeight: `${HUD_INTENT_LINE_HEIGHT}px`,
      maxHeight: `${HUD_INTENT_LINE_HEIGHT * HUD_INTENT_MAX_LINES}px`,
    },
  };
}

/** Existing metadata/error cap; intent always uses the uncut display model. */
export function hudSecondaryText(value: string | number | null | undefined, max = 180): string {
  const text = hudIntentDisplay(value).text;
  const characters = Array.from(text);
  return characters.length > max ? `${characters.slice(0, max - 1).join('')}…` : text;
}
