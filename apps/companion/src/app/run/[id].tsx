import { Redirect, useLocalSearchParams } from 'expo-router';

import { routeParamString } from '../../features/workspace-shared/route-params';
import {
  runWorkspacePathnames,
  runWorkspaceTabForLegacyPackageTab,
} from '../../lib/legacy-run-route';

export default function LegacyRunRoute() {
  const { id, packageTab, ...params } = useLocalSearchParams();
  const target = runWorkspaceTabForLegacyPackageTab(routeParamString(packageTab));

  return (
    <Redirect
      href={{
        pathname: runWorkspacePathnames[target],
        params: { ...params, runId: routeParamString(id) },
      }}
    />
  );
}
