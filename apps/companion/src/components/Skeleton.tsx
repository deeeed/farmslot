import {
  type DimensionValue,
  Pressable,
  type StyleProp,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';

import { type SkeletonKind, skeletonTokens } from '@farmslot/theme';

import { colors } from '../lib/theme';

/** Shared shapes; the consuming component owns its loading composition. */
export function Skeleton({
  kind = 'line',
  width = '100%',
  height,
  style,
  color = skeletonTokens.colors.dark,
}: {
  color?: string;
  kind?: SkeletonKind;
  width?: DimensionValue;
  height?: number;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={[
        {
          width: kind === 'avatar' ? skeletonTokens.heights.avatar : width,
          height: height ?? skeletonTokens.heights[kind],
          borderRadius:
            kind === 'avatar' ? skeletonTokens.heights.avatar / 2 : skeletonTokens.radius,
          backgroundColor: color,
        },
        style,
      ]}
    />
  );
}

export function SkeletonError({
  message,
  retry,
  color = colors.textSecondary,
}: {
  message: string;
  retry?: () => void;
  color?: string;
}) {
  return (
    <View accessibilityRole="alert" style={styles.error}>
      <Text numberOfLines={1} style={[styles.message, { color }]}>
        {message}
      </Text>
      {retry ? (
        <Pressable accessibilityRole="button" style={styles.retry} onPress={retry}>
          <Text style={[styles.message, { color }]}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  error: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 12 },
  message: { color: colors.textSecondary, flexShrink: 1 },
  retry: { minHeight: 44, minWidth: 44, justifyContent: 'center', paddingHorizontal: 12 },
});
