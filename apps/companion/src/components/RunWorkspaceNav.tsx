import { useRouter } from 'expo-router';
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { DECISION_EVIDENCE_RECIPE_RUN_PARAM } from '../lib/artifact-url';
import { colors, fonts, radii, spacing } from '../lib/theme';
import {
  artifactFilterParamForArtifactPath,
  artifactFilterParamForWorkspaceNav,
  familyRouteContextForWorkspaceNav,
  familySectionParamForWorkspaceNav,
  familySectionRouteContextParams,
  recipeWorkspaceParam,
  recipeWorkspaceScopeLabel,
  shouldPreserveArtifactForDecisionEvidenceContext,
  shouldPreserveArtifactForDiffContext,
  shouldPreserveArtifactForRecipeContext,
  targetWorkspaceRouteContextParams,
  terminalDetailsParamForWorkspaceNav,
  workspaceArtifactPathParam,
  type WorkspaceRouteWorkspace,
} from '../lib/workspace-navigation';

type WorkspaceNavTarget =
  | 'family'
  | 'slot'
  | 'run'
  | 'pr'
  | 'ready'
  | 'review'
  | 'retro'
  | 'familyRetros'
  | 'terminal'
  | 'artifacts'
  | 'compare'
  | 'recipe'
  | 'diff';

const DEFAULT_NAV_PRIORITY: WorkspaceNavTarget[] = [
  'slot',
  'terminal',
  'ready',
  'compare',
  'artifacts',
  'recipe',
  'diff',
  'review',
  'retro',
  'familyRetros',
  'family',
  'run',
  'pr',
];

const NAV_PRIORITIES: Partial<Record<WorkspaceNavTarget, WorkspaceNavTarget[]>> = {
  ready: [
    'ready',
    'compare',
    'artifacts',
    'recipe',
    'diff',
    'terminal',
    'slot',
    'review',
    'retro',
    'familyRetros',
    'family',
    'run',
    'pr',
  ],
  review: [
    'review',
    'pr',
    'ready',
    'compare',
    'artifacts',
    'recipe',
    'diff',
    'terminal',
    'slot',
    'familyRetros',
    'family',
    'run',
  ],
  retro: [
    'retro',
    'familyRetros',
    'family',
    'compare',
    'artifacts',
    'recipe',
    'diff',
    'terminal',
    'slot',
    'ready',
    'review',
    'run',
    'pr',
  ],
  familyRetros: [
    'familyRetros',
    'retro',
    'family',
    'compare',
    'artifacts',
    'recipe',
    'diff',
    'terminal',
    'slot',
    'ready',
    'review',
    'run',
    'pr',
  ],
  slot: [
    'slot',
    'terminal',
    'ready',
    'review',
    'retro',
    'familyRetros',
    'compare',
    'artifacts',
    'recipe',
    'pr',
    'diff',
    'run',
    'family',
  ],
  terminal: [
    'terminal',
    'ready',
    'review',
    'retro',
    'pr',
    'compare',
    'artifacts',
    'recipe',
    'diff',
    'slot',
    'run',
    'familyRetros',
    'family',
  ],
  artifacts: [
    'artifacts',
    'compare',
    'recipe',
    'ready',
    'review',
    'retro',
    'pr',
    'diff',
    'terminal',
    'slot',
    'familyRetros',
    'family',
    'run',
  ],
  recipe: [
    'recipe',
    'compare',
    'artifacts',
    'diff',
    'terminal',
    'slot',
    'ready',
    'retro',
    'familyRetros',
    'review',
    'family',
    'run',
    'pr',
  ],
  diff: [
    'diff',
    'pr',
    'compare',
    'artifacts',
    'recipe',
    'terminal',
    'slot',
    'ready',
    'retro',
    'familyRetros',
    'review',
    'family',
    'run',
  ],
  family: [
    'family',
    'retro',
    'familyRetros',
    'pr',
    'compare',
    'artifacts',
    'recipe',
    'diff',
    'terminal',
    'slot',
    'ready',
    'review',
    'run',
  ],
  run: [
    'run',
    'ready',
    'review',
    'retro',
    'familyRetros',
    'pr',
    'compare',
    'artifacts',
    'recipe',
    'diff',
    'terminal',
    'slot',
    'family',
  ],
  pr: [
    'pr',
    'family',
    'run',
    'ready',
    'compare',
    'artifacts',
    'recipe',
    'diff',
    'terminal',
    'slot',
    'retro',
    'familyRetros',
    'review',
  ],
  compare: [
    'compare',
    'artifacts',
    'recipe',
    'diff',
    'terminal',
    'slot',
    'ready',
    'review',
    'retro',
    'familyRetros',
    'family',
    'run',
    'pr',
  ],
};

interface RunWorkspaceNavProps {
  familyId?: string | null;
  project?: string | null;
  slotId?: string | null;
  runId?: string | null;
  prNumber?: number | null;
  prRepo?: string | null;
  decisionId?: string | null;
  decisionKind?: string | null;
  readyDecisionId?: string | null;
  reviewDecisionId?: string | null;
  retroDecisionId?: string | null;
  readyMeta?: string | null;
  reviewMeta?: string | null;
  retroMeta?: string | null;
  recipeRunId?: string | null;
  recipeAvailable?: boolean;
  recipeArtifactCount?: number | null;
  diffAvailable?: boolean;
  artifactCount?: number | null;
  artifactPath?: string | null;
  visualPairCount?: number;
  familyRetrospectiveCount?: number | null;
  pendingFamilyRetrospectiveCount?: number | null;
  compareArtifactPath?: string | null;
  compareRunId?: string | null;
  compareRecipeRunId?: string | null;
  current?: WorkspaceNavTarget;
  routeWorkspace?: WorkspaceRouteWorkspace | null;
  routeDecisionKind?: string | null;
  dense?: boolean;
}

export function RunWorkspaceNav({
  familyId,
  project,
  slotId,
  runId,
  prNumber,
  prRepo,
  decisionId,
  decisionKind,
  readyDecisionId,
  reviewDecisionId,
  retroDecisionId,
  readyMeta,
  reviewMeta,
  retroMeta,
  recipeRunId,
  recipeAvailable,
  recipeArtifactCount,
  diffAvailable,
  artifactCount,
  artifactPath,
  visualPairCount = 0,
  familyRetrospectiveCount,
  pendingFamilyRetrospectiveCount,
  compareArtifactPath,
  compareRunId,
  compareRecipeRunId,
  current,
  routeDecisionKind,
  dense = false,
}: RunWorkspaceNavProps) {
  const router = useRouter();
  const decisionTarget: WorkspaceNavTarget =
    decisionKind === 'retrospective' || current === 'retro'
      ? 'retro'
      : decisionKind === 'ready' || current === 'ready'
        ? 'ready'
        : 'review';
  const resolvedReadyDecisionId =
    readyDecisionId ?? (decisionTarget === 'ready' ? decisionId : null);
  const resolvedReviewDecisionId =
    reviewDecisionId ?? (decisionTarget === 'review' ? decisionId : null);
  const resolvedRetroDecisionId =
    retroDecisionId ?? (decisionTarget === 'retro' ? decisionId : null);
  const canOpenReadyFocus = Boolean(resolvedReadyDecisionId);
  const canOpenReviewFocus = Boolean(resolvedReviewDecisionId);
  const canOpenRetroFocus = Boolean(resolvedRetroDecisionId);
  const canOpenFamilyRetros = Boolean(familyId);
  const familyRetrosMeta = canOpenFamilyRetros
    ? familyRetrospectiveNavMeta(pendingFamilyRetrospectiveCount, familyRetrospectiveCount)
    : 'No family';
  const terminalDetailsParam = terminalDetailsParamForWorkspaceNav(current);
  const familySectionParam = familySectionParamForWorkspaceNav(current);
  const artifactFilterParam = artifactFilterParamForWorkspaceNav(current);
  const preservedArtifactPath = workspaceArtifactPathParam(artifactPath);
  const preserveDecisionEvidenceArtifact = shouldPreserveArtifactForDecisionEvidenceContext(
    recipeRunId,
    artifactPath,
  );
  const decisionEvidenceArtifactFilter =
    (preserveDecisionEvidenceArtifact
      ? artifactFilterParamForArtifactPath(artifactPath)
      : undefined) ??
    artifactFilterParam ??
    artifactFilterParamForWorkspaceNav('review');
  const recipeScoped = Boolean(recipeRunId) && recipeRunId !== DECISION_EVIDENCE_RECIPE_RUN_PARAM;
  const recipeScopeLabel = recipeWorkspaceScopeLabel(recipeRunId);
  const compareTargetRunId = compareRunId ?? runId;
  const routeDecisionKindParam = routeDecisionKind ?? decisionKind;
  const familyRouteContext = familyRouteContextForWorkspaceNav(current, routeDecisionKindParam);
  const targetRouteContext = (targetWorkspace: WorkspaceRouteWorkspace) =>
    targetWorkspaceRouteContextParams(targetWorkspace, routeDecisionKindParam);
  const actions: Array<{
    id: WorkspaceNavTarget;
    label: string;
    meta: string;
    disabled?: boolean;
    hidden?: boolean;
    onPress: () => void;
  }> = [
    {
      id: 'family',
      label: 'Family',
      meta: familyId ? shortId(familyId) : 'No family',
      disabled: !familyId,
      onPress: () => {
        if (!familyId) return;
        router.push({
          pathname: '/family/[familyId]',
          params: {
            familyId,
            ...(project ? { project } : {}),
            ...familyRouteContext,
            ...(runId ? { runId } : {}),
            ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
            ...(preservedArtifactPath ? { artifact: preservedArtifactPath } : {}),
            ...(familySectionParam ? { section: familySectionParam } : {}),
          },
        });
      },
    },
    {
      id: 'slot',
      label: 'Slot',
      meta: slotId ?? 'No slot',
      disabled: !slotId,
      onPress: () => {
        if (!slotId) return;
        router.push({
          pathname: '/slot/[id]',
          params: {
            id: slotId,
            ...targetRouteContext('slot'),
            ...(runId ? { runId } : {}),
            ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
            ...(preservedArtifactPath ? { artifact: preservedArtifactPath } : {}),
          },
        });
      },
    },
    {
      id: 'run',
      label: 'Run detail',
      meta: runId ? (recipeScoped ? 'Recipe ctx' : shortId(runId)) : 'No run',
      disabled: !runId,
      onPress: () => {
        if (!runId) return;
        router.push({
          pathname: '/run/[id]',
          params: {
            id: runId,
            ...targetRouteContext('run'),
            ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
            ...(preservedArtifactPath ? { artifact: preservedArtifactPath } : {}),
          },
        });
      },
    },
    {
      id: 'pr',
      label: 'PR',
      meta: prNumber ? `#${prNumber}` : 'No PR',
      disabled: !prNumber,
      onPress: () => {
        if (!prNumber) return;
        router.push({
          pathname: '/(tabs)/prs',
          params: {
            pr: String(prNumber),
            ...targetRouteContext('pr'),
            ...(prRepo ? { repo: prRepo } : {}),
          },
        });
      },
    },
    {
      id: 'ready',
      label: 'Ready gate',
      meta: resolvedReadyDecisionId ? readyMeta || shortId(resolvedReadyDecisionId) : 'No ready',
      disabled: !canOpenReadyFocus,
      hidden: !resolvedReadyDecisionId,
      onPress: () => {
        if (!resolvedReadyDecisionId) return;
        router.push({
          pathname: '/decision/[id]',
          params: {
            id: resolvedReadyDecisionId,
            workspace: 'ready',
            decisionKind: 'ready',
            ...(runId ? { runId } : {}),
            ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
            ...(preservedArtifactPath ? { artifact: preservedArtifactPath } : {}),
          },
        });
      },
    },
    {
      id: 'review',
      label: 'Review gate',
      meta: resolvedReviewDecisionId ? reviewMeta || shortId(resolvedReviewDecisionId) : 'No gate',
      disabled: !canOpenReviewFocus,
      hidden: !resolvedReviewDecisionId,
      onPress: () => {
        if (!resolvedReviewDecisionId) return;
        router.push({
          pathname: '/decision/[id]',
          params: {
            id: resolvedReviewDecisionId,
            workspace: 'review',
            decisionKind: 'review',
            ...(runId ? { runId } : {}),
            ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
            ...(preservedArtifactPath ? { artifact: preservedArtifactPath } : {}),
          },
        });
      },
    },
    {
      id: 'retro',
      label: 'Retro gate',
      meta: resolvedRetroDecisionId ? retroMeta || shortId(resolvedRetroDecisionId) : 'No retro',
      disabled: !canOpenRetroFocus,
      hidden: !resolvedRetroDecisionId,
      onPress: () => {
        if (!resolvedRetroDecisionId) return;
        router.push({
          pathname: '/decision/[id]',
          params: {
            id: resolvedRetroDecisionId,
            workspace: 'retro',
            decisionKind: 'retrospective',
            ...(runId ? { runId } : {}),
            ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
            ...(preservedArtifactPath ? { artifact: preservedArtifactPath } : {}),
          },
        });
      },
    },
    {
      id: 'familyRetros',
      label: 'Family retros',
      meta: familyRetrosMeta,
      disabled: !canOpenFamilyRetros,
      onPress: () => {
        if (!familyId) return;
        router.push({
          pathname: '/family/[familyId]',
          params: {
            familyId,
            ...(project ? { project } : {}),
            ...familySectionRouteContextParams('retros', routeDecisionKindParam),
            ...(runId ? { runId } : {}),
            ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
            ...(preservedArtifactPath ? { artifact: preservedArtifactPath } : {}),
            section: 'retros',
          },
        });
      },
    },
    {
      id: 'terminal',
      label: 'Terminal',
      meta: slotId ? 'Live' : 'No slot',
      disabled: !slotId,
      onPress: () => {
        if (!slotId) return;
        router.push({
          pathname: '/terminal/[slotId]',
          params: {
            slotId,
            ...targetRouteContext('terminal'),
            ...(runId ? { runId } : {}),
            ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
            ...(preservedArtifactPath ? { artifact: preservedArtifactPath } : {}),
            ...(terminalDetailsParam ? { details: terminalDetailsParam } : {}),
          },
        });
      },
    },
    {
      id: 'artifacts',
      label: 'Evidence files',
      meta: runId ? fileCountNavMeta(artifactCount, 'Evidence') : 'No run',
      disabled: !runId,
      onPress: () => {
        if (!runId) return;
        router.push({
          pathname: '/artifacts/[runId]',
          params: {
            runId,
            ...targetRouteContext('artifacts'),
            recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
            ...(decisionEvidenceArtifactFilter ? { filter: decisionEvidenceArtifactFilter } : {}),
            ...(preserveDecisionEvidenceArtifact ? { artifact: artifactPath } : {}),
          },
        });
      },
    },
    {
      id: 'recipe',
      label: 'Recipe files',
      meta: recipeNavMeta({
        available: recipeAvailable,
        count: recipeArtifactCount,
        hasRun: Boolean(runId),
        scopeLabel: recipeScopeLabel,
      }),
      disabled: !runId || recipeAvailable === false,
      onPress: () => {
        if (!runId) return;
        const recipeTarget = recipeWorkspaceParam(recipeRunId);
        router.push({
          pathname: '/artifacts/[runId]',
          params: {
            runId,
            ...targetRouteContext('recipe'),
            recipeRun: recipeTarget,
            filter: artifactFilterParamForWorkspaceNav('recipe'),
            ...(shouldPreserveArtifactForRecipeContext(recipeTarget, artifactPath)
              ? { artifact: artifactPath }
              : {}),
          },
        });
      },
    },

    {
      id: 'compare',
      label: 'Before→After',
      meta:
        visualPairCount > 0
          ? `Identify ${visualPairCount} delta pair${visualPairCount === 1 ? '' : 's'}`
          : 'No pairs',
      disabled: !compareTargetRunId || visualPairCount === 0,
      onPress: () => {
        if (!compareTargetRunId || visualPairCount === 0) return;
        router.push({
          pathname: '/artifacts/[runId]',
          params: {
            runId: compareTargetRunId,
            ...targetRouteContext('compare'),
            recipeRun: compareRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
            filter: artifactFilterParamForWorkspaceNav('compare'),
            ...(compareArtifactPath ? { artifact: compareArtifactPath } : {}),
          },
        });
      },
    },
    {
      id: 'diff',
      label: 'Diff view',
      meta: runId
        ? diffAvailable === false
          ? slotId
            ? 'Workspace'
            : 'No diff'
          : 'Files'
        : slotId
          ? 'Workspace'
          : 'No target',
      disabled: (!runId && !slotId) || (Boolean(runId) && diffAvailable === false && !slotId),
      onPress: () => {
        if (runId && diffAvailable !== false) {
          router.push({
            pathname: '/diff/[runId]',
            params: {
              runId,
              ...targetRouteContext('diff'),
              ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
              ...(shouldPreserveArtifactForDiffContext(artifactPath) ? { path: artifactPath } : {}),
            },
          });
          return;
        }
        if (slotId) {
          router.push({
            pathname: '/diff/slot/[slotId]',
            params: {
              slotId,
              ...targetRouteContext('diff'),
              ...(shouldPreserveArtifactForDiffContext(artifactPath) ? { path: artifactPath } : {}),
            },
          });
        }
      },
    },
  ];
  const visibleActions = actions
    .filter((action) => !action.hidden && (!action.disabled || action.id === current))
    .sort((left, right) => {
      const priority = current
        ? (NAV_PRIORITIES[current] ?? DEFAULT_NAV_PRIORITY)
        : DEFAULT_NAV_PRIORITY;
      return navRank(priority, left.id) - navRank(priority, right.id);
    });

  return (
    <View style={[styles.container, dense && styles.containerDense]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {visibleActions.map((action) => {
          const active = current === action.id;
          const showMeta = !dense || active;
          const compactMeta = dense && !active ? compactActionMeta(action.id, action.meta) : null;
          return (
            <Pressable
              key={action.id}
              style={[
                styles.action,
                dense && styles.actionDense,
                active && styles.actionActive,
                action.disabled && styles.actionDisabled,
              ]}
              onPress={action.onPress}
              disabled={action.disabled || active}
            >
              <View style={styles.actionLabelRow}>
                <Text
                  style={[
                    styles.actionLabel,
                    dense && styles.actionLabelDense,
                    active && styles.actionLabelActive,
                  ]}
                >
                  {action.label}
                </Text>
                {compactMeta ? (
                  <Text
                    style={[styles.actionCompactMeta, active && styles.actionCompactMetaActive]}
                    numberOfLines={1}
                  >
                    {compactMeta}
                  </Text>
                ) : null}
              </View>
              {showMeta ? (
                <Text style={styles.actionMeta} numberOfLines={1}>
                  {action.meta}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

function navRank(priority: WorkspaceNavTarget[], target: WorkspaceNavTarget): number {
  const index = priority.indexOf(target);
  return index >= 0 ? index : priority.length;
}

function shortId(value: string): string {
  if (value.length <= 10) return value;
  return `${value.slice(0, 8)}…`;
}

function familyRetrospectiveNavMeta(
  pending: number | null | undefined,
  total: number | null | undefined,
): string {
  if (typeof pending === 'number' && pending > 0) {
    return `${pending} pending`;
  }
  if (typeof total === 'number') {
    if (total > 0) return `${total} total`;
    return 'No retros';
  }
  return 'Retros';
}

function fileCountNavMeta(count: number | null | undefined, fallback: string): string {
  if (typeof count !== 'number') return fallback;
  return `${count} file${count === 1 ? '' : 's'}`;
}

function recipeNavMeta({
  available,
  count,
  hasRun,
  scopeLabel,
}: {
  available?: boolean;
  count?: number | null;
  hasRun: boolean;
  scopeLabel: ReturnType<typeof recipeWorkspaceScopeLabel>;
}): string {
  if (!hasRun) return 'No run';
  if (available === false) return 'No recipe';
  if (typeof count === 'number') return fileCountNavMeta(count, 'Recipe');
  return scopeLabel === 'selected' ? 'Selected' : 'Current';
}

function compactActionMeta(target: WorkspaceNavTarget, meta: string): string | null {
  if (!meta || /^No\b/i.test(meta) || meta === 'Live') return null;

  if (target === 'artifacts' || target === 'recipe') {
    const count = meta.match(/^(\d+)\s+files?/i)?.[1];
    if (count) return count;
    if (/loading/i.test(meta)) return '…';
    return null;
  }

  if (target === 'compare') {
    const count = meta.match(/(\d+)\s+delta pair/i)?.[1];
    return count ? `${count}×` : null;
  }

  if (target === 'ready' || target === 'review' || target === 'retro') {
    const state = meta.split('·')[0]?.trim().toLowerCase();
    if (!state) return null;
    if (state.includes('pending')) return 'pending';
    if (state.includes('warning')) return 'warn';
    if (state.includes('ready')) return 'ready';
    if (state.includes('resolved') || state.includes('recorded')) return 'done';
    return state.length <= 8 ? state : null;
  }

  if (target === 'familyRetros') {
    const pending = meta.match(/^(\d+)\s+pending/i);
    if (pending) return `${pending[1]} pending`;
    const total = meta.match(/^(\d+)\s+total/i);
    return total ? total[1] : null;
  }

  if (target === 'pr' && meta.startsWith('#')) return meta;

  return null;
}

const styles = StyleSheet.create({
  container: {
    marginBottom: spacing.xl,
  },
  containerDense: {
    marginBottom: spacing.sm,
  },
  scrollContent: {
    gap: spacing.sm,
    paddingRight: spacing.lg,
  },
  action: {
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    minWidth: 88,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  actionDense: {
    alignItems: 'center',
    borderRadius: 999,
    minWidth: 0,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  actionActive: {
    backgroundColor: colors.accent + '22',
    borderColor: colors.accent,
  },
  actionDisabled: {
    opacity: 0.42,
  },
  actionLabel: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
  },
  actionLabelRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
  },
  actionLabelDense: {
    fontSize: fonts.sizeXs,
  },
  actionLabelActive: {
    color: colors.accent,
  },
  actionMeta: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    marginTop: 2,
  },
  actionCompactMeta: {
    backgroundColor: colors.accent + '18',
    borderColor: colors.accent + '33',
    borderRadius: 999,
    borderWidth: 1,
    color: colors.accent,
    fontSize: 9,
    fontWeight: '900',
    overflow: 'hidden',
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  actionCompactMetaActive: {
    backgroundColor: colors.accent + '28',
  },
});
