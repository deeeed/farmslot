import { useLocalSearchParams } from 'expo-router';

import { routeParamString } from '../../../../features/workspace-shared/route-params';
import { WorkspaceTabsLayout } from '../../../../features/workspace-shared/WorkspaceTabsLayout';
import { selectReviewWorkspaceDecision } from '../../../../lib/workspace-decisions';
import { useRunStore } from '../../../../store/runs';

export default function RunWorkspaceTabsLayout() {
  const { runId, recipeRun, artifact, workspace, decisionKind, decisionId } = useLocalSearchParams<{
    runId: string | string[];
    recipeRun?: string | string[];
    artifact?: string | string[];
    workspace?: string | string[];
    decisionKind?: string | string[];
    decisionId?: string | string[];
  }>();
  const resolvedRunId = routeParamString(runId);
  const run = useRunStore((state) =>
    state.runs.find((candidate) => candidate.id === resolvedRunId),
  );
  const gateDecisionId =
    routeParamString(decisionId) || selectReviewWorkspaceDecision(run)?.id || '';
  const params = {
    runId: resolvedRunId,
    ...(routeParamString(recipeRun) ? { recipeRun: routeParamString(recipeRun) } : {}),
    ...(routeParamString(artifact) ? { artifact: routeParamString(artifact) } : {}),
    ...(routeParamString(workspace) ? { workspace: routeParamString(workspace) } : {}),
    ...(routeParamString(decisionKind) ? { decisionKind: routeParamString(decisionKind) } : {}),
    ...(gateDecisionId ? { decisionId: gateDecisionId } : {}),
  };

  const tabs = [
    {
      href: { pathname: '/workspace/run/[runId]/evidence' as const, params },
      label: 'Evidence',
      name: 'evidence',
      testID: 'companion-run-tab-evidence',
    },
    {
      href: { pathname: '/workspace/run/[runId]/diff' as const, params },
      label: 'Diff',
      name: 'diff',
      testID: 'companion-run-tab-diff',
    },
    {
      href: { pathname: '/workspace/run/[runId]/timeline' as const, params },
      label: 'Timeline',
      name: 'timeline',
      testID: 'companion-run-tab-timeline',
    },
    {
      href: { pathname: '/workspace/run/[runId]/files' as const, params },
      label: 'Files',
      name: 'files',
      testID: 'companion-run-tab-files',
    },
    ...(gateDecisionId
      ? [
          {
            href: { pathname: '/workspace/run/[runId]/gate' as const, params },
            label: 'Gate',
            name: 'gate',
            testID: 'companion-run-tab-gate',
          },
        ]
      : []),
  ];

  return <WorkspaceTabsLayout fallbackHref="/(tabs)/runs" title="Run Detail" tabs={tabs} />;
}
