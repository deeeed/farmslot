import { Redirect, useLocalSearchParams } from 'expo-router';

import { routeParamString } from '../../features/workspace-shared/route-params';

export default function LegacyRunArtifactsRoute() {
  const { runId, recipeRun, artifact, filter, workspace, decisionKind } = useLocalSearchParams<{
    runId: string | string[];
    recipeRun?: string | string[];
    artifact?: string | string[];
    filter?: string | string[];
    workspace?: string | string[];
    decisionKind?: string | string[];
  }>();

  return (
    <Redirect
      href={{
        pathname: '/workspace/run/[runId]/files',
        params: {
          runId: routeParamString(runId),
          ...(routeParamString(recipeRun) ? { recipeRun: routeParamString(recipeRun) } : {}),
          ...(routeParamString(artifact) ? { artifact: routeParamString(artifact) } : {}),
          ...(routeParamString(filter) ? { filter: routeParamString(filter) } : {}),
          ...(routeParamString(workspace) ? { workspace: routeParamString(workspace) } : {}),
          ...(routeParamString(decisionKind)
            ? { decisionKind: routeParamString(decisionKind) }
            : {}),
        },
      }}
    />
  );
}
