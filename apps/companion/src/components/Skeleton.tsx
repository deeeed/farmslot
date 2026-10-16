import {
  type DimensionValue,
  Pressable,
  type StyleProp,
  StyleSheet,
  Text,
  useColorScheme,
  View,
  type ViewStyle,
} from 'react-native';

import { publicationGateColors, type SkeletonKind, skeletonTokens } from '@farmslot/theme';

import { colors } from '../lib/theme';

/** Shared shapes; the consuming component owns its loading composition. */
export function Skeleton({
  kind = 'line',
  width = '100%',
  height,
  style,
}: {
  kind?: SkeletonKind;
  width?: DimensionValue;
  height?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const appearance = useColorScheme();
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
          backgroundColor: skeletonTokens.colors[appearance === 'light' ? 'light' : 'dark'],
        },
        style,
      ]}
    />
  );
}

export function SkeletonError({ message, retry }: { message: string; retry?: () => void }) {
  const appearance = useColorScheme();
  const foreground = publicationGateColors[appearance === 'light' ? 'light' : 'dark'].secondary;
  return (
    <View accessibilityRole="alert" style={styles.error}>
      <Text numberOfLines={1} style={[styles.message, { color: foreground }]}>
        {message}
      </Text>
      {retry ? (
        <Pressable accessibilityRole="button" style={styles.retry} onPress={retry}>
          <Text style={[styles.message, { color: foreground }]}>Retry</Text>
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
