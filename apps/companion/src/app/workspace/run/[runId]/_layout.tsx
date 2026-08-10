import { useLocalSearchParams } from 'expo-router';

import { routeParamString } from '../../../../features/workspace-shared/route-params';
import { WorkspaceTabsLayout } from '../../../../features/workspace-shared/WorkspaceTabsLayout';

export default function RunWorkspaceTabsLayout() {
  const { runId, recipeRun, artifact, workspace, decisionKind } = useLocalSearchParams<{
    runId: string | string[];
    recipeRun?: string | string[];
    artifact?: string | string[];
    workspace?: string | string[];
    decisionKind?: string | string[];
  }>();
  const resolvedRunId = routeParamString(runId);
  const params = {
    runId: resolvedRunId,
    ...(routeParamString(recipeRun) ? { recipeRun: routeParamString(recipeRun) } : {}),
    ...(routeParamString(artifact) ? { artifact: routeParamString(artifact) } : {}),
    ...(routeParamString(workspace) ? { workspace: routeParamString(workspace) } : {}),
    ...(routeParamString(decisionKind) ? { decisionKind: routeParamString(decisionKind) } : {}),
  };

  return (
    <WorkspaceTabsLayout
      fallbackHref="/(tabs)/runs"
      title="Run Detail"
      tabs={[
        {
          href: { pathname: '/workspace/run/[runId]/evidence', params },
          label: 'Evidence',
          name: 'evidence',
          testID: 'companion-run-tab-evidence',
        },
        {
          href: { pathname: '/workspace/run/[runId]/diff', params },
          label: 'Diff',
          name: 'diff',
          testID: 'companion-run-tab-diff',
        },
        {
          href: { pathname: '/workspace/run/[runId]/timeline', params },
          label: 'Timeline',
          name: 'timeline',
          testID: 'companion-run-tab-timeline',
        },
        {
          href: { pathname: '/workspace/run/[runId]/files', params },
          label: 'Files',
          name: 'files',
          testID: 'companion-run-tab-files',
        },
      ]}
    />
  );
}
