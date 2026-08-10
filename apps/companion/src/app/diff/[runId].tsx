import { Redirect, useLocalSearchParams } from 'expo-router';

import { routeParamString } from '../../features/workspace-shared/route-params';

export default function LegacyRunDiffRoute() {
  const { runId, ...params } = useLocalSearchParams();

  return (
    <Redirect
      href={{
        pathname: '/workspace/run/[runId]/diff',
        params: { ...params, runId: routeParamString(runId) },
      }}
    />
  );
}
