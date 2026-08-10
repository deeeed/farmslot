import { Redirect, useLocalSearchParams } from 'expo-router';

import { routeParamString } from '../../features/workspace-shared/route-params';

export default function LegacySlotRoute() {
  const { id, ...params } = useLocalSearchParams();

  return (
    <Redirect
      href={{
        pathname: '/workspace/slot/[slotId]/slot',
        params: { ...params, slotId: routeParamString(id) },
      }}
    />
  );
}
