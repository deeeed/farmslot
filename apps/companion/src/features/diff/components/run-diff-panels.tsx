import { useRouter } from 'expo-router';
import { Pressable, ScrollView, Text, View } from 'react-native';

import {
  type RecipeRunArtifactGroup,
  type Run,
  type TaskProgressStructured,
} from '@farmslot/protocol';

import {
  artifactsForRecipeRun,
  CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
  DECISION_EVIDENCE_RECIPE_RUN_PARAM,
  type VisualArtifactPair,
} from '../../../lib/artifact-url';
import { prRepoFromWorkspaceSource } from '../../../lib/pr-links';
import { fallbackTaskProgressSummary, taskProgressPercent } from '../../../lib/task-progress';
import {
  artifactFilterParamForWorkspaceNav,
  decisionWorkspaceRouteParams,
  familySectionRouteContextParams,
  recipeWorkspaceParam,
  recipeWorkspaceScopeLabel,
  shouldPreserveArtifactForRecipeContext,
  targetWorkspaceRouteContextParams,
  type WorkspaceRouteContext,
} from '../../../lib/workspace-navigation';
import { runDiffStyles as styles } from '../styles/run-diff.styles';

export function DiffWorkspaceCockpit({
  run,
  runId,
  diffPath,
  focusedFilePath,
  manifestCount,
  visualPairCount,
  compareArtifactPath,
  recipeRunId,
  compareRecipeRunId,
  recipeLabel,
  readyDecisionId,
  reviewDecisionId,
  retroDecisionId,
  diffSource,
  activeTaskProgress,
  fallbackTaskProgress,
  workspaceRouteContext,
}: {
  run: Run | null;
  runId: string;
  diffPath: string;
  focusedFilePath: string;
  manifestCount: number;
  visualPairCount: number;
  compareArtifactPath: string | null;
  recipeRunId?: string | null;
  compareRecipeRunId?: string | null;
  recipeLabel?: string;
  readyDecisionId: string | null;
  reviewDecisionId: string | null;
  retroDecisionId: string | null;
  diffSource: 'artifact' | 'live workspace' | 'missing';
  activeTaskProgress: TaskProgressStructured | null;
  fallbackTaskProgress: ReturnType<typeof fallbackTaskProgressSummary> | null;
  workspaceRouteContext: WorkspaceRouteContext;
}) {
  const router = useRouter();
  const diffRouteContext = targetWorkspaceRouteContextParams(
    'diff',
    workspaceRouteContext.decisionKind,
  );
  const compareRouteContext = targetWorkspaceRouteContextParams(
    'compare',
    workspaceRouteContext.decisionKind,
  );
  const recipeRouteContext = targetWorkspaceRouteContextParams(
    'recipe',
    workspaceRouteContext.decisionKind,
  );
  const slotRouteContext = targetWorkspaceRouteContextParams(
    'slot',
    workspaceRouteContext.decisionKind,
  );
  const runRouteContext = targetWorkspaceRouteContextParams(
    'run',
    workspaceRouteContext.decisionKind,
  );
  const terminalRouteContext = targetWorkspaceRouteContextParams(
    'terminal',
    workspaceRouteContext.decisionKind,
  );
  const prRouteContext = targetWorkspaceRouteContextParams(
    'pr',
    workspaceRouteContext.decisionKind,
  );
  const contextLabel =
    recipeLabel ??
    (recipeRunId === DECISION_EVIDENCE_RECIPE_RUN_PARAM
      ? 'decision evidence'
      : (recipeRunId ?? 'run evidence'));
  const progressValue = activeTaskProgress
    ? `${Math.round(taskProgressPercent(activeTaskProgress))}%`
    : fallbackTaskProgress?.percent != null
      ? `${Math.round(fallbackTaskProgress.percent)}%`
      : fallbackTaskProgress
        ? 'live'
        : '-';
  const artifactParams = {
    runId,
    ...diffRouteContext,
    ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
    filter: artifactFilterParamForWorkspaceNav('diff'),
    ...(diffPath ? { artifact: diffPath } : {}),
  };
  const openArtifacts = () =>
    router.push({
      pathname: '/artifacts/[runId]',
      params: artifactParams,
    });
  const openCompareArtifacts = () =>
    router.push({
      pathname: '/artifacts/[runId]',
      params: {
        runId,
        ...compareRouteContext,
        ...(compareRecipeRunId ? { recipeRun: compareRecipeRunId } : {}),
        filter: artifactFilterParamForWorkspaceNav('compare'),
        ...(compareArtifactPath ? { artifact: compareArtifactPath } : {}),
      },
    });
  const openRecipe = () => {
    const recipeTarget = recipeWorkspaceParam(recipeRunId);
    router.push({
      pathname: '/artifacts/[runId]',
      params: {
        runId,
        ...recipeRouteContext,
        recipeRun: recipeTarget,
        filter: artifactFilterParamForWorkspaceNav('recipe'),
        ...(shouldPreserveArtifactForRecipeContext(recipeTarget, diffPath)
          ? { artifact: diffPath }
          : {}),
      },
    });
  };
  const openSlot = () => {
    if (!run?.slotId) return;
    router.push({
      pathname: '/slot/[id]',
      params: {
        id: run.slotId,
        ...slotRouteContext,
        runId,
        ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
        ...(diffPath ? { artifact: diffPath } : {}),
      },
    });
  };
  const openFamily = () => {
    if (!run?.familyId) return;
    router.push({
      pathname: '/family/[familyId]',
      params: {
        familyId: run.familyId,
        project: run.project,
        ...familySectionRouteContextParams('ledger', workspaceRouteContext.decisionKind),
        runId,
        section: 'ledger',
        ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
        ...(diffPath ? { artifact: diffPath } : {}),
      },
    });
  };
  const openFamilyRetros = () => {
    if (!run?.familyId) return;
    router.push({
      pathname: '/family/[familyId]',
      params: {
        familyId: run.familyId,
        project: run.project,
        ...familySectionRouteContextParams('retros', workspaceRouteContext.decisionKind),
        runId,
        section: 'retros',
        ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
        ...(diffPath ? { artifact: diffPath } : {}),
      },
    });
  };
  const openRun = () =>
    router.push({
      pathname: '/run/[id]',
      params: {
        id: runId,
        ...runRouteContext,
        ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
        ...(diffPath ? { artifact: diffPath } : {}),
      },
    });
  const openPR = () => {
    if (!run?.prNumber) return;
    const prRepo = prRepoFromWorkspaceSource(run, run.prNumber);
    router.push({
      pathname: '/(tabs)/prs',
      params: {
        pr: String(run.prNumber),
        ...prRouteContext,
        ...(prRepo ? { repo: prRepo } : {}),
      },
    });
  };
  const openDecision = (decisionId: string | null) => {
    if (!decisionId) return;
    router.push({
      pathname: '/decision/[id]',
      params: {
        id: decisionId,
        ...decisionWorkspaceRouteParams(
          decisionId === readyDecisionId
            ? 'ready'
            : decisionId === retroDecisionId
              ? 'retrospective'
              : 'review',
        ),
        runId,
        ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
        ...(diffPath ? { artifact: diffPath } : {}),
      },
    });
  };
  return (
    <View style={styles.cockpitPanel}>
      <View style={styles.cockpitHeader}>
        <View style={styles.cockpitTitleBlock}>
          <Text style={styles.cockpitTitle}>Diff cockpit</Text>
          <Text style={styles.cockpitMeta} numberOfLines={1}>
            {contextLabel} · {diffSource}
          </Text>
        </View>
        <Pressable
          style={[styles.cockpitPill, !run?.slotId && styles.cockpitDisabled]}
          disabled={!run?.slotId}
          onPress={() => {
            if (!run?.slotId) return;
            router.push({
              pathname: '/terminal/[slotId]',
              params: {
                slotId: run.slotId,
                ...terminalRouteContext,
                runId,
                details: '1',
                ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
                ...(diffPath ? { artifact: diffPath } : {}),
              },
            });
          }}
        >
          <Text style={styles.cockpitPillText}>Terminal</Text>
        </Pressable>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.cockpitRail}
      >
        <DiffCockpitTile label="Source" value={diffSource} />
        <DiffCockpitTile label="Diff files" value={String(manifestCount)} onPress={openArtifacts} />
        <DiffCockpitTile
          label="Before→After"
          value={
            visualPairCount > 0
              ? `${visualPairCount} delta${visualPairCount === 1 ? '' : 's'}`
              : 'none'
          }
          onPress={openCompareArtifacts}
          disabled={visualPairCount === 0}
        />
        <DiffCockpitTile label="File" value={focusedFilePath || 'all'} />
        <DiffCockpitTile
          label="Ready gate"
          value={readyDecisionId ? 'available' : '-'}
          onPress={() => openDecision(readyDecisionId)}
          disabled={!readyDecisionId}
        />
        <DiffCockpitTile
          label="Review gate"
          value={reviewDecisionId ? 'available' : '-'}
          onPress={() => openDecision(reviewDecisionId)}
          disabled={!reviewDecisionId}
        />
        <DiffCockpitTile
          label="Retro gate"
          value={retroDecisionId ? 'available' : '-'}
          onPress={() => openDecision(retroDecisionId)}
          disabled={!retroDecisionId}
        />
        <DiffCockpitTile
          label="Progress"
          value={progressValue}
          disabled={!activeTaskProgress && !fallbackTaskProgress}
        />
        <DiffCockpitTile
          label="PR"
          value={run?.prNumber ? `#${run.prNumber}` : '-'}
          onPress={openPR}
          disabled={!run?.prNumber}
        />
        <DiffCockpitTile label="Path" value={diffPath || 'workspace'} />
        <DiffCockpitTile
          label="Slot"
          value={run?.slotId ?? '-'}
          onPress={openSlot}
          disabled={!run?.slotId}
        />
        <DiffCockpitTile
          label="Recipe files"
          value={recipeWorkspaceScopeLabel(recipeRunId)}
          onPress={openRecipe}
        />
        <DiffCockpitTile
          label="Family"
          value={shortId(run?.familyId)}
          onPress={openFamily}
          disabled={!run?.familyId}
        />
        <DiffCockpitTile
          label="Family retros"
          value={run?.familyId ? 'open' : '-'}
          onPress={openFamilyRetros}
          disabled={!run?.familyId}
        />
        <DiffCockpitTile label="Run" value={shortId(runId)} onPress={openRun} />
      </ScrollView>
    </View>
  );
}
export function DiffCockpitTile({
  label,
  value,
  onPress,
  disabled,
}: {
  label: string;
  value: string;
  onPress?: () => void;
  disabled?: boolean;
}) {
  const content = (
    <>
      <Text style={styles.cockpitTileLabel}>{label}</Text>
      <Text style={styles.cockpitTileValue} numberOfLines={1}>
        {value}
      </Text>
    </>
  );
  if (onPress) {
    return (
      <Pressable
        style={[styles.cockpitTile, disabled && styles.cockpitDisabled]}
        onPress={onPress}
        disabled={disabled}
      >
        {content}
      </Pressable>
    );
  }
  return <View style={styles.cockpitTile}>{content}</View>;
}
export function shortId(value: string | null | undefined): string {
  if (!value) return '-';
  return value.length > 10 ? `${value.slice(0, 8)}…` : value;
}
export function routeParamString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}
export function recipeRunIdForVisualPair(
  recipeRuns: RecipeRunArtifactGroup[],
  pair: VisualArtifactPair | null,
  selectedRecipeRunId: string | null,
): string {
  if (!pair) return selectedRecipeRunId ?? recipeRuns[0]?.id ?? CURRENT_ARTIFACTS_RECIPE_RUN_PARAM;
  const directRecipeRunId = pair.after.recipeRunId ?? pair.before.recipeRunId;
  if (directRecipeRunId) return directRecipeRunId;
  const sourceGroup = recipeRuns.find((group) => {
    const artifacts = artifactsForRecipeRun(group);
    return artifacts.some(
      (artifact) => artifact.path === pair.before.path || artifact.path === pair.after.path,
    );
  });
  return (
    sourceGroup?.id ??
    selectedRecipeRunId ??
    recipeRuns[0]?.id ??
    CURRENT_ARTIFACTS_RECIPE_RUN_PARAM
  );
}
