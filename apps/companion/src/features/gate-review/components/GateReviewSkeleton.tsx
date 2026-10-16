import { StyleSheet, useColorScheme, useWindowDimensions, View } from 'react-native';

import { gateClaimsHeight, publicationGateColors, skeletonTokens } from '@farmslot/theme';

import { Skeleton, SkeletonError } from '../../../components/Skeleton';

export function GateClaimSkeleton() {
  return (
    <View style={styles.claim}>
      <Skeleton width="25%" />
      <Skeleton width="85%" />
      <Skeleton width="65%" />
      <Skeleton kind="button" width={140} />
      <Skeleton width="45%" />
      <Skeleton kind="button" width={112} />
    </View>
  );
}

/** Same status, bounded AC list and action row as GateActions. */
export function GateReviewSkeleton({
  rows = 3,
  error,
  retry,
}: {
  rows?: number;
  error?: string;
  retry?: () => void;
}) {
  const viewport = useWindowDimensions();
  const appearance = useColorScheme();
  const palette = publicationGateColors[appearance === 'light' ? 'light' : 'dark'];
  return (
    <View
      accessibilityLabel="Gate"
      accessibilityState={{ busy: !error }}
      style={[styles.panel, { backgroundColor: palette.background, borderColor: palette.border }]}
    >
      <View style={styles.status}>
        {error ? <SkeletonError message={error} retry={retry} /> : <Skeleton width="60%" />}
      </View>
      <View>
        <View style={styles.label}>
          <Skeleton width="40%" />
        </View>
        <View style={{ height: gateClaimsHeight(rows, viewport.height), overflow: 'hidden' }}>
          {Array.from({ length: rows }, (_, index) => (
            <GateClaimSkeleton key={index} />
          ))}
        </View>
      </View>
      <View style={styles.actions}>
        <Skeleton kind="button" width={144} />
        <Skeleton kind="button" width={100} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { padding: 12, borderWidth: 1, borderRadius: 6, gap: 12 },
  status: { minHeight: 44, justifyContent: 'center' },
  label: { height: 24, justifyContent: 'center' },
  claim: { minHeight: skeletonTokens.gateRow, paddingVertical: 8, gap: 12 },
  actions: { flexDirection: 'row', gap: 12 },
});
