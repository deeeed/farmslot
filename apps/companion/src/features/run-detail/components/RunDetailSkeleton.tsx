import { View } from 'react-native';

import { Skeleton, SkeletonError } from '../../../components/Skeleton';

export function RunDetailSkeleton({ error, retry }: { error?: string; retry?: () => void }) {
  return (
    <View
      accessibilityLabel="Run details"
      accessibilityState={{ busy: !error }}
      style={{ flex: 1, padding: 16, gap: 16 }}
    >
      <View style={{ height: 44, justifyContent: 'center' }}>
        {error ? <SkeletonError message={error} retry={retry} /> : <Skeleton width="70%" />}
      </View>
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <Skeleton kind="button" width="30%" />
        <Skeleton kind="button" width="30%" />
        <Skeleton kind="button" width="30%" />
      </View>
      <Skeleton kind="block" height={120} />
      <Skeleton width="40%" />
      {Array.from({ length: 6 }, (_, index) => (
        <View key={index} style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
          <Skeleton kind="avatar" />
          <Skeleton kind="row" width="78%" />
        </View>
      ))}
    </View>
  );
}
