import { Redirect, useLocalSearchParams } from 'expo-router';

import { withViewState } from '../../components/view-state';
import { routeParamString } from '../../features/workspace-shared/route-params';

function LegacyTerminalRoute() {
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

export default withViewState(LegacyTerminalRoute);
