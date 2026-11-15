// From T3 Code apps/mobile/src/features/review/nativeReviewDiffAdapter.ts and lib/typography.ts
// (b8c2cfad): the native diff view's code surface, style and theme. T3 takes the surface from its
// appearance settings and the theme from its theme variables; Companion has one dark theme, so the
// surface is T3's default and the theme reads Companion's tokens.
import { colors } from '../../../lib/theme';
import type { NativeReviewDiffTheme } from '../diffs/nativeReviewDiffSurface';

export interface ResolvedMobileCodeSurface {
  readonly fontSize: number;
  readonly lineNumberFontSize: number;
  readonly rowHeight: number;
  readonly gutterWidth: number;
  readonly codePadding: number;
  readonly textVerticalInset: number;
}

export const MOBILE_CODE_SURFACE: ResolvedMobileCodeSurface = {
  rowHeight: 22,
  gutterWidth: 46,
  codePadding: 7,
  textVerticalInset: 2,
  fontSize: 12,
  lineNumberFontSize: 11,
};

/** T3's `label` text size, which the empty-state message scales from. */
export const MOBILE_LABEL_FONT_SIZE = 13;

const NATIVE_HEX_COLOR = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})([\da-f]{2})?$/i;
const NATIVE_RGBA_COLOR =
  /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/;

export const NATIVE_REVIEW_DIFF_CONTENT_WIDTH = 2_800;

function opaqueNativeHexColor(color: string, background: string): string {
  const hex = NATIVE_HEX_COLOR.exec(color);
  if (hex && !hex[4]) return color;

  const rgba = NATIVE_RGBA_COLOR.exec(color);
  const backgroundHex = NATIVE_HEX_COLOR.exec(background);
  if ((!hex && !rgba) || !backgroundHex) return background;

  const alpha = hex
    ? Number.parseInt(hex[4] ?? 'ff', 16) / 255
    : rgba?.[4] === undefined
      ? 1
      : Math.min(1, Math.max(0, Number(rgba[4])));
  const channels = [1, 2, 3].map((index) => {
    const foreground = hex ? Number.parseInt(hex[index] ?? '0', 16) : Number(rgba?.[index]);
    const behind = Number.parseInt(backgroundHex[index] ?? '0', 16);
    return Math.round(foreground * alpha + behind * (1 - alpha));
  });
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

export function createNativeReviewDiffStyle(
  codeSurface: ResolvedMobileCodeSurface,
  wordWrap: boolean,
) {
  return {
    wordWrap,
    rowHeight: codeSurface.rowHeight,
    contentWidth: NATIVE_REVIEW_DIFF_CONTENT_WIDTH,
    changeBarWidth: 4,
    gutterWidth: codeSurface.gutterWidth,
    codePadding: codeSurface.codePadding,
    textVerticalInset: codeSurface.textVerticalInset,
    fileHeaderHeight: 56,
    fileHeaderHorizontalMargin: 8,
    fileHeaderVerticalMargin: 6,
    fileHeaderCornerRadius: 10,
    fileHeaderHorizontalPadding: 10,
    fileHeaderPathRightPadding: 118,
    fileHeaderCountColumnWidth: 38,
    fileHeaderCountGap: 5,
    codeFontSize: codeSurface.fontSize,
    codeFontWeight: 'regular',
    lineNumberFontSize: codeSurface.lineNumberFontSize,
    lineNumberFontWeight: 'regular',
    hunkFontSize: 11,
    hunkFontWeight: 'medium',
    fileHeaderFontSize: 11,
    fileHeaderFontWeight: 'semibold',
    fileHeaderMetaFontSize: 10,
    fileHeaderMetaFontWeight: 'semibold',
    fileHeaderSubtextFontSize: 11,
    fileHeaderSubtextFontWeight: 'medium',
    fileHeaderStatusFontSize: 9,
    fileHeaderStatusFontWeight: 'bold',
    emptyStateFontSize: 12,
    emptyStateFontWeight: 'medium',
  } as const;
}

/** T3's dark diff theme, with Companion's surface colors in place of T3's theme variables. */
export function createNativeReviewDiffTheme(): NativeReviewDiffTheme {
  // Swift and Android disagree on alpha-byte order; flatten to shared opaque #RRGGBB.
  const screen = opaqueNativeHexColor(colors.bgBase, '#000000');
  const background = opaqueNativeHexColor(colors.bgSurface, screen);
  const nativeColor = (color: string) => opaqueNativeHexColor(color, background);
  return {
    background,
    text: nativeColor(colors.textPrimary),
    mutedText: nativeColor(colors.textSecondary),
    headerBackground: background,
    border: nativeColor(colors.bgCardHover),
    hunkBackground: nativeColor(colors.bgCard),
    hunkText: nativeColor(colors.textPrimary),
    addBackground: '#0d2f28',
    deleteBackground: '#391415',
    addBar: '#00cab1',
    deleteBar: '#ff2e3f',
    addText: '#5ECC71',
    deleteText: '#FF6762',
  };
}
