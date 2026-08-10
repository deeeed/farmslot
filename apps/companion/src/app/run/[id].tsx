import { Redirect, useLocalSearchParams } from 'expo-router';

import { routeParamString } from '../../features/workspace-shared/route-params';

export default function LegacyRunRoute() {
  const { id, packageTab, ...params } = useLocalSearchParams();
  const requestedTab = routeParamString(packageTab);
  const target =
    requestedTab === 'diff' || requestedTab === 'timeline' || requestedTab === 'files'
      ? requestedTab
      : 'evidence';
  const pathname = {
    diff: '/workspace/run/[runId]/diff',
    evidence: '/workspace/run/[runId]/evidence',
    files: '/workspace/run/[runId]/files',
    timeline: '/workspace/run/[runId]/timeline',
  } as const;

  return (
    <Redirect
      href={{
        pathname: pathname[target],
        params: { ...params, runId: routeParamString(id) },
      }}
    />
  );
}
