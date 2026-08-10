import { Redirect, useLocalSearchParams } from 'expo-router';

import { routeParamString } from '../../features/workspace-shared/route-params';

export default function LegacyTerminalRoute() {
  const { slotId, ...params } = useLocalSearchParams();

  return (
    <Redirect
      href={{
        pathname: '/workspace/slot/[slotId]/terminal',
        params: { ...params, slotId: routeParamString(slotId) },
      }}
    />
  );
}
