import { useWindowDimensions, View } from 'react-native';

import { Skeleton, SkeletonError } from './Skeleton';

export function EvidenceReviewSkeleton({ error, retry }: { error?: string; retry?: () => void }) {
  const viewport = useWindowDimensions();
  return (
    <View
      accessibilityLabel="Evidence"
      accessibilityState={{ busy: !error }}
      style={{
        height: Math.min(640, viewport.height * 0.65),
        padding: 12,
        gap: 12,
        overflow: 'hidden',
      }}
    >
      <View style={{ height: 44, justifyContent: 'center' }}>
        {error ? <SkeletonError message={error} retry={retry} /> : <Skeleton width="40%" />}
      </View>
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <Skeleton kind="button" width={72} />
        <Skeleton kind="button" width={100} />
      </View>
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <Skeleton kind="block" width="48%" height={180} />
        <Skeleton kind="block" width="48%" height={180} />
      </View>
      <Skeleton width="70%" />
    </View>
  );
}
