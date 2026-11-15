import { Platform } from 'react-native';

import { colors, fonts } from '../../lib/theme';
import type { NativeMarkdownTextStyle } from '../../t3/native/SelectableMarkdownText.types';

/** Companion's dark tokens for T3's native markdown text. */
export const nativeMarkdownTextStyle: NativeMarkdownTextStyle = {
  color: colors.textPrimary,
  strongColor: '#ffffff',
  mutedColor: colors.textSecondary,
  linkColor: colors.accentHover,
  inlineCodeColor: '#c9d1d9',
  codeColor: colors.textPrimary,
  codeBackgroundColor: colors.bgSurface,
  codeBlockBackgroundColor: colors.bgSurface,
  fileTextColor: colors.accentHover,
  quoteMarkerColor: colors.bgCardHover,
  dividerColor: colors.bgCardHover,
  fontSize: fonts.sizeSm,
  lineHeight: 21,
  // Android draws its own selection unless a color is given.
  ...(Platform.OS === 'android'
    ? { selectionColor: `${colors.accent}52`, selectionHandleColor: colors.accent }
    : {}),
};
