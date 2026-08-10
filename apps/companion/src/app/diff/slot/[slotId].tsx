import { Redirect, useLocalSearchParams } from 'expo-router';

import { routeParamString } from '../../../features/workspace-shared/route-params';

export default function LegacySlotDiffRoute() {
  const { slotId, ...params } = useLocalSearchParams();

  return (
    <Redirect
      href={{
        pathname: '/workspace/slot/[slotId]/diff',
        params: { ...params, slotId: routeParamString(slotId) },
      }}
    />
  );
}
