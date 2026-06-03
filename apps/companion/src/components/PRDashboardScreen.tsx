import { FlashList } from '@shopify/flash-list';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  Methods,
  type PRListResult,
  type PRRecommendation,
  type PRStatus,
  type RunCreateResult,
} from '@farmslot/protocol';

import {
  CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
  DECISION_EVIDENCE_RECIPE_RUN_PARAM,
} from '../lib/artifact-url';
import {
  buildPRDashboardRows,
  buildPRDashboardScope,
  filterDashboardPRs,
  type PRDashboardRow,
  type PRDashboardSortMode,
} from '../lib/pr-dashboard';
import { baseStyles, colors, fonts, radii, spacing } from '../lib/theme';
import {
  artifactFilterParamForWorkspaceNav,
  familySectionRouteContextParams,
  targetWorkspaceRouteContextParams,
  workspaceRouteContextParams,
} from '../lib/workspace-navigation';
import { useConnectionStore } from '../store/connection';
import { useFilterStore } from '../store/filters';
import { usePRStore } from '../store/prs';

type PRFilter = 'attention' | 'active' | 'ready' | 'all';

const FILTERS: Array<{ id: PRFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'attention', label: 'Attention' },
  { id: 'active', label: 'Active' },
  { id: 'ready', label: 'Ready' },
];

const PR_LIST_TIMEOUT_MS = 30_000;

const RECOMMENDATION_LABELS: Record<PRRecommendation, string> = {
  WORKING: 'Working',
  NEEDS_ATTENTION: 'Needs attention',
  IN_REVIEW: 'In review',
  READY: 'Ready',
  WAITING_FOR_MERGE: 'Waiting for merge',
  MERGED: 'Merged',
  CLOSED_WITHOUT_MERGE: 'Closed',
};

function recommendationColor(rec: PRRecommendation): string {
  switch (rec) {
    case 'NEEDS_ATTENTION':
      return colors.statusFail;
    case 'READY':
    case 'MERGED':
      return colors.statusOk;
    case 'IN_REVIEW':
    case 'WAITING_FOR_MERGE':
      return colors.statusWarn;
    case 'WORKING':
      return colors.accent;
    case 'CLOSED_WITHOUT_MERGE':
      return colors.textMuted;
    default:
      return colors.textMuted;
  }
}

function prNeedsAttention(pr: PRStatus): boolean {
  return (
    pr.recommendation === 'NEEDS_ATTENTION' ||
    pr.mergeConflict ||
    pr.anyFailed ||
    pr.actionableBotComments.length > 0
  );
}

function prMatchesFilter(pr: PRStatus, filter: PRFilter): boolean {
  switch (filter) {
    case 'attention':
      return prNeedsAttention(pr);
    case 'active':
      return ['WORKING', 'IN_REVIEW', 'NEEDS_ATTENTION'].includes(pr.recommendation);
    case 'ready':
      return ['READY', 'WAITING_FOR_MERGE'].includes(pr.recommendation);
    case 'all':
      return true;
    default:
      return true;
  }
}

function routeParamString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function parseRoutePR(value: string | string[] | undefined): number | null {
  const normalized = routeParamString(value).trim();
  if (!normalized) return null;
  const parsed = Number(normalized.replace(/^#/, ''));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function matchesFocusedPR(pr: PRStatus, prNumber: number | null, repo: string): boolean {
  if (!prNumber || pr.pr !== prNumber) return false;
  return !repo || pr.repo === repo;
}

function ensureFocusedPRVisible(visible: PRStatus[], focused: PRStatus | null): PRStatus[] {
  if (!focused) return visible;
  const remaining = visible.filter((pr) => pr.repo !== focused.repo || pr.pr !== focused.pr);
  return [focused, ...remaining];
}

async function openGithubPR(pr: PRStatus): Promise<void> {
  const url = `https://github.com/${pr.repo}/pull/${pr.pr}`;
  const supported = await Linking.canOpenURL(url);
  if (!supported) throw new Error(`Cannot open ${url}`);
  await Linking.openURL(url);
}

function PRCard({
  pr,
  dispatching,
  onOpenGithub,
  onOpenFamily,
  onOpenLatestRun,
  onOpenSlot,
  onOpenArtifacts,
  onOpenCompare,
  onOpenRecipe,
  onOpenDiff,
  onOpenTerminal,
  onDispatchComplete,
}: {
  pr: PRStatus;
  dispatching: boolean;
  onOpenGithub: () => void;
  onOpenFamily: () => void;
  onOpenLatestRun: () => void;
  onOpenSlot: () => void;
  onOpenArtifacts: () => void;
  onOpenCompare: () => void;
  onOpenRecipe: () => void;
  onOpenDiff: () => void;
  onOpenTerminal: () => void;
  onDispatchComplete: () => void;
}) {
  const { passed, failed, pending, total } = pr.checkSummary;
  const all = pr.allCheckSummary;
  const recColor = recommendationColor(pr.recommendation);
  const hasFamily = Boolean(pr.familyId);
  const hasLatestRun = Boolean(pr.latestRunId);
  const hasDiffTarget = hasLatestRun || Boolean(pr.slot);
  const canComplete = pr.prState === 'OPEN' && pr.recommendation === 'NEEDS_ATTENTION';
  const primaryIssue = primaryAttentionReason(pr);

  return (
    <View style={[styles.prCard, prNeedsAttention(pr) && styles.attentionCard]}>
      <View style={styles.topRow}>
        <Text style={styles.prNumber}>#{pr.pr}</Text>
        <View style={[styles.recommendationBadge, { backgroundColor: recColor + '22' }]}>
          <Text style={[styles.recommendationText, { color: recColor }]}>
            {RECOMMENDATION_LABELS[pr.recommendation]}
          </Text>
        </View>
        {pr.slot ? <Text style={styles.slotText}>{pr.slot}</Text> : null}
      </View>

      <Text style={styles.prTitle} numberOfLines={2}>
        {pr.title}
      </Text>
      {pr.summary ? (
        <Text style={baseStyles.textMuted} numberOfLines={2}>
          {pr.summary}
        </Text>
      ) : null}
      {primaryIssue ? <Text style={styles.issueText}>{primaryIssue}</Text> : null}

      <View style={styles.ciBar}>
        {passed > 0 ? (
          <View style={[styles.ciSegment, { flex: passed, backgroundColor: colors.statusOk }]} />
        ) : null}
        {failed > 0 ? (
          <View style={[styles.ciSegment, { flex: failed, backgroundColor: colors.statusFail }]} />
        ) : null}
        {pending > 0 ? (
          <View style={[styles.ciSegment, { flex: pending, backgroundColor: colors.statusWarn }]} />
        ) : null}
        {total === 0 ? (
          <View style={[styles.ciSegment, { flex: 1, backgroundColor: colors.textMuted }]} />
        ) : null}
      </View>

      <View style={styles.metaRow}>
        <Text style={baseStyles.textMuted}>
          CI {passed}/{total} pass · {failed} fail · {pending} pending
        </Text>
        <Text
          style={[
            baseStyles.textMuted,
            { color: pr.mergeConflict ? colors.statusFail : colors.statusOk },
          ]}
        >
          {pr.mergeConflict ? 'Conflicts' : pr.merged ? 'Merged' : pr.prState}
        </Text>
      </View>
      {all && all.total !== total ? (
        <Text style={baseStyles.textMuted} numberOfLines={1}>
          GitHub total: {all.passed} pass · {all.failed} fail · {all.pending} pending ·{' '}
          {all.skipped} skipped
        </Text>
      ) : null}
      {pr.ownedFamily ? (
        <Text style={baseStyles.textMuted} numberOfLines={1}>
          Family: {pr.workflowState ?? 'unknown'} · {pr.familyRunCount ?? 0} runs ·{' '}
          {pr.mergeState?.replace(/_/g, ' ') ?? 'merge unknown'}
        </Text>
      ) : null}

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.actions}
      >
        {canComplete ? (
          <PRAction
            label={dispatching ? 'Starting…' : 'Complete'}
            value="pr-complete"
            primary
            disabled={dispatching}
            onPress={onDispatchComplete}
          />
        ) : null}
        {hasFamily ? (
          <PRAction label="Family" value={shortId(pr.familyId ?? '')} onPress={onOpenFamily} />
        ) : null}
        {hasLatestRun ? (
          <PRAction
            label="Run detail"
            value={shortId(pr.latestRunId ?? '')}
            onPress={onOpenLatestRun}
          />
        ) : null}
        {pr.slot ? <PRAction label="Slot" value={pr.slot} onPress={onOpenSlot} /> : null}
        {hasLatestRun ? (
          <PRAction label="Evidence files" value="review" onPress={onOpenArtifacts} />
        ) : null}
        {hasLatestRun ? (
          <PRAction label="Before→After" value="compare" onPress={onOpenCompare} />
        ) : null}
        {hasLatestRun ? (
          <PRAction label="Recipe files" value="current" onPress={onOpenRecipe} />
        ) : null}
        {hasDiffTarget ? (
          <PRAction
            label="Diff view"
            value={hasLatestRun ? (pr.slot ? 'run/workspace' : 'run') : 'workspace'}
            onPress={onOpenDiff}
          />
        ) : null}
        {pr.slot ? <PRAction label="Terminal" value="live" onPress={onOpenTerminal} /> : null}
        <PRAction label="GitHub" value="open" onPress={onOpenGithub} />
      </ScrollView>
    </View>
  );
}

function PRAction({
  label,
  value,
  onPress,
  primary,
  disabled,
}: {
  label: string;
  value: string;
  onPress: () => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      style={[
        styles.actionButton,
        primary && styles.primaryAction,
        disabled && styles.actionDisabled,
      ]}
      disabled={disabled}
      onPress={onPress}
    >
      <Text style={[styles.actionText, primary && styles.primaryActionText]}>{label}</Text>
      <Text style={styles.actionValue} numberOfLines={1}>
        {value}
      </Text>
    </Pressable>
  );
}

export function PRDashboardScreen({ showStackTitle = false }: { showStackTitle?: boolean }) {
  const {
    pr: focusedPRParam,
    repo: focusedRepoParam,
    workspace,
    decisionKind,
  } = useLocalSearchParams<{
    pr?: string | string[];
    repo?: string | string[];
    workspace?: string | string[];
    decisionKind?: string | string[];
  }>();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const client = useConnectionStore((s) => s.client);
  const status = useConnectionStore((s) => s.status);
  const globalFilters = useFilterStore((s) => s.filters);
  const clearGlobalFilters = useFilterStore((s) => s.clearAll);
  const setFilterEditorExpanded = useFilterStore((s) => s.setEditorExpanded);
  const prs = usePRStore((s) => s.prs);
  const loading = usePRStore((s) => s.loading);
  const error = usePRStore((s) => s.lastError);
  const updatedAt = usePRStore((s) => s.updatedAt);
  const setPRs = usePRStore((s) => s.setPRs);
  const setPRLoading = usePRStore((s) => s.setLoading);
  const setPRError = usePRStore((s) => s.setError);
  const [filter, setFilter] = useState<PRFilter>('all');
  const [sortMode, setSortMode] = useState<PRDashboardSortMode>('group');
  const [refreshing, setRefreshing] = useState(false);
  const [dispatchingKey, setDispatchingKey] = useState<string | null>(null);
  const focusedPRNumber = parseRoutePR(focusedPRParam);
  const focusedRepo = routeParamString(focusedRepoParam).trim();
  const prWorkspaceRouteContext = useMemo(
    () =>
      workspaceRouteContextParams(
        routeParamString(workspace),
        routeParamString(decisionKind),
        'pr',
      ),
    [decisionKind, workspace],
  );
  const diffRouteContext = useMemo(
    () => targetWorkspaceRouteContextParams('diff', prWorkspaceRouteContext.decisionKind),
    [prWorkspaceRouteContext.decisionKind],
  );

  const fetchPRs = useCallback(async () => {
    if (!client) {
      setPRLoading(false);
      return;
    }
    setRefreshing(true);
    setPRLoading(true);
    setPRError(null);
    try {
      const result = await client.request<PRListResult>(Methods.PR_LIST, {}, PR_LIST_TIMEOUT_MS);
      setPRs(result.prs);
    } catch (err) {
      setPRError(`Failed to load PR list: ${(err as Error).message}`);
    } finally {
      setRefreshing(false);
    }
  }, [client, setPRError, setPRLoading, setPRs]);

  useEffect(() => {
    if (status === 'connected' && (!updatedAt || Date.now() - updatedAt > PR_LIST_TIMEOUT_MS)) {
      void fetchPRs();
    }
  }, [fetchPRs, status, updatedAt]);

  useEffect(() => {
    if (status !== 'connected') return;
    const interval = setInterval(() => {
      void fetchPRs();
    }, 60_000);
    return () => clearInterval(interval);
  }, [fetchPRs, status]);

  const commandCenterPRs = useMemo(
    () => filterDashboardPRs(prs, globalFilters),
    [globalFilters, prs],
  );
  const scope = useMemo(() => buildPRDashboardScope(prs, globalFilters), [globalFilters, prs]);
  const focusedPR = useMemo(
    () => prs.find((pr) => matchesFocusedPR(pr, focusedPRNumber, focusedRepo)) ?? null,
    [focusedPRNumber, focusedRepo, prs],
  );
  const focusHiddenByFilters =
    Boolean(focusedPR) &&
    !commandCenterPRs.some(
      (pr) => focusedPR && pr.repo === focusedPR.repo && pr.pr === focusedPR.pr,
    );
  const counts = useMemo(
    () => ({
      attention: commandCenterPRs.filter(prNeedsAttention).length,
      active: commandCenterPRs.filter((pr) => prMatchesFilter(pr, 'active')).length,
      ready: commandCenterPRs.filter((pr) => prMatchesFilter(pr, 'ready')).length,
      all: commandCenterPRs.length,
    }),
    [commandCenterPRs],
  );
  const visiblePRs = useMemo(
    () =>
      ensureFocusedPRVisible(
        commandCenterPRs.filter((pr) => prMatchesFilter(pr, filter)),
        focusedPR,
      ),
    [commandCenterPRs, filter, focusedPR],
  );
  const visibleRows = useMemo(
    () => buildPRDashboardRows(visiblePRs, sortMode),
    [sortMode, visiblePRs],
  );

  const handleOpenGithub = useCallback((pr: PRStatus) => {
    openGithubPR(pr).catch((err: Error) => Alert.alert('Cannot open GitHub', err.message));
  }, []);

  const handleDispatchComplete = useCallback(
    (pr: PRStatus) => {
      if (!client) {
        Alert.alert('Not connected', 'Connect to the gateway before dispatching PR completion.');
        return;
      }
      Alert.alert('Start PR completion?', `Dispatch pr-complete for ${pr.repo}#${pr.pr}?`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Start',
          style: 'default',
          onPress: () => {
            const key = `${pr.repo}#${pr.pr}`;
            setDispatchingKey(key);
            client
              .request<RunCreateResult>(Methods.RUN_CREATE, {
                flowType: 'pr-complete',
                project: pr.project,
                ticketOrPr: `${pr.repo}#${pr.pr}`,
                prNumber: pr.pr,
                mode: 'autonomous',
              })
              .then((result) => {
                router.push({
                  pathname: '/run/[id]',
                  params: {
                    id: result.run.id,
                    recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  },
                });
              })
              .catch((err: Error) => {
                Alert.alert('Dispatch failed', err.message);
              })
              .finally(() => setDispatchingKey(null));
          },
        },
      ]);
    },
    [client, router],
  );

  const header = (
    <View style={styles.headerContent}>
      <View style={styles.titleRow}>
        {showStackTitle ? <View /> : <Text style={styles.screenTitle}>Pull Requests</Text>}
        <Pressable
          style={[styles.actionButton, styles.headerRefreshButton]}
          onPress={fetchPRs}
          disabled={refreshing}
        >
          <Text style={styles.actionText}>{refreshing ? 'Refreshing…' : 'Refresh'}</Text>
        </Pressable>
      </View>
      <View style={styles.summaryRow}>
        <SummaryPill label="Attention" value={counts.attention} color={colors.statusFail} />
        <SummaryPill label="Active" value={counts.active} color={colors.accent} />
        <SummaryPill label="Ready" value={counts.ready} color={colors.statusOk} />
      </View>
      <Text style={styles.scopeText} numberOfLines={2}>
        {scope.summary}
      </Text>
      {scope.hiddenByScope > 0 || scope.reviewOnly > 0 ? (
        <View style={styles.scopeCard}>
          <Text style={styles.scopeTitle}>PR scope</Text>
          <Text style={styles.scopeMeta} numberOfLines={3}>
            {scope.hiddenByScope > 0
              ? `${scope.hiddenByScope} owned PR${scope.hiddenByScope === 1 ? ' is' : 's are'} outside the active project/machine scope. `
              : ''}
            {scope.reviewOnly > 0
              ? `${scope.reviewOnly} gateway PR${scope.reviewOnly === 1 ? ' is' : 's are'} review-only and hidden from the owned PR board.`
              : ''}
          </Text>
          {scope.hiddenByScope > 0 ? (
            <View style={styles.scopeActions}>
              <Pressable
                style={[styles.actionButton, styles.scopeActionButton]}
                onPress={() => {
                  setFilter('all');
                  clearGlobalFilters();
                }}
              >
                <Text style={styles.actionText}>Show all owned</Text>
              </Pressable>
              <Pressable
                style={[styles.actionButton, styles.scopeActionButton]}
                onPress={() => setFilterEditorExpanded(true)}
              >
                <Text style={styles.actionText}>Edit scope</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      ) : null}
      {focusedPRNumber ? (
        <View style={styles.focusCard}>
          <Text style={styles.focusTitle}>
            {focusedPR
              ? `Focused PR ${focusedPR.repo}#${focusedPR.pr}`
              : `Focused PR #${focusedPRNumber}`}
          </Text>
          <Text style={styles.focusMeta} numberOfLines={2}>
            {focusedPR
              ? focusHiddenByFilters
                ? 'Shown above current project/machine filters because you opened it from a workspace.'
                : 'Opened from a run, slot, family, artifact, diff, or review workspace.'
              : loading
                ? 'Loading gateway PR cache…'
                : 'Not found in the current gateway PR cache. Tap Refresh if this PR was just created.'}
          </Text>
        </View>
      ) : null}
      <View style={styles.filterRow}>
        {FILTERS.map((item) => {
          const active = filter === item.id;
          return (
            <Pressable
              key={item.id}
              style={[styles.filterChip, active && styles.filterChipActive]}
              onPress={() => setFilter(item.id)}
            >
              <Text style={[styles.filterText, active && styles.filterTextActive]}>
                {item.label} {counts[item.id]}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <View style={styles.sortRow}>
        <Text style={styles.sortLabel}>Sort</Text>
        <Pressable
          style={[styles.sortChip, sortMode === 'group' && styles.sortChipActive]}
          onPress={() => setSortMode('group')}
        >
          <Text style={[styles.sortText, sortMode === 'group' && styles.sortTextActive]}>
            By type
          </Text>
        </Pressable>
        <Pressable
          style={[styles.sortChip, sortMode === 'date' && styles.sortChipActive]}
          onPress={() => setSortMode('date')}
        >
          <Text style={[styles.sortText, sortMode === 'date' && styles.sortTextActive]}>
            By date
          </Text>
        </Pressable>
      </View>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </View>
  );

  return (
    <View style={baseStyles.container}>
      {visibleRows.length === 0 && !loading ? (
        <View style={[styles.emptyContainer, { paddingBottom: insets.bottom }]}>
          {header}
          <Text style={baseStyles.textSecondary}>
            {status !== 'connected'
              ? 'Connect to gateway.'
              : error
                ? 'Refresh after the gateway responds.'
                : 'No PRs match this filter.'}
          </Text>
          {status === 'connected' ? (
            <Pressable style={[styles.actionButton, styles.refreshButton]} onPress={fetchPRs}>
              <Text style={styles.actionText}>Refresh</Text>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <FlashList
          data={visibleRows}
          keyExtractor={prDashboardRowKey}
          ListHeaderComponent={header}
          renderItem={({ item }) =>
            item.kind === 'group' ? (
              <View style={styles.groupHeader}>
                <Text style={styles.groupHeaderText}>{item.group.label}</Text>
                <Text style={styles.groupHeaderCount}>{item.count}</Text>
              </View>
            ) : (
              <PRCard
                pr={item.pr}
                dispatching={dispatchingKey === `${item.pr.repo}#${item.pr.pr}`}
                onOpenGithub={() => handleOpenGithub(item.pr)}
                onOpenFamily={() => {
                  if (!item.pr.familyId) return;
                  router.push({
                    pathname: '/family/[familyId]',
                    params: {
                      familyId: item.pr.familyId,
                      project: item.pr.project,
                      ...familySectionRouteContextParams(
                        'focus',
                        prWorkspaceRouteContext.decisionKind,
                      ),
                      ...(item.pr.latestRunId ? { runId: item.pr.latestRunId } : {}),
                      section: 'focus',
                    },
                  });
                }}
                onOpenLatestRun={() => {
                  if (!item.pr.latestRunId) return;
                  router.push({
                    pathname: '/run/[id]',
                    params: {
                      id: item.pr.latestRunId,
                      ...prWorkspaceRouteContext,
                      recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                    },
                  });
                }}
                onOpenSlot={() => {
                  if (!item.pr.slot) return;
                  router.push({
                    pathname: '/slot/[id]',
                    params: {
                      id: item.pr.slot,
                      ...prWorkspaceRouteContext,
                      ...(item.pr.latestRunId ? { runId: item.pr.latestRunId } : {}),
                      recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                    },
                  });
                }}
                onOpenArtifacts={() => {
                  if (!item.pr.latestRunId) return;
                  router.push({
                    pathname: '/artifacts/[runId]',
                    params: {
                      runId: item.pr.latestRunId,
                      ...prWorkspaceRouteContext,
                      recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                      filter: artifactFilterParamForWorkspaceNav('review'),
                    },
                  });
                }}
                onOpenCompare={() => {
                  if (!item.pr.latestRunId) return;
                  router.push({
                    pathname: '/artifacts/[runId]',
                    params: {
                      runId: item.pr.latestRunId,
                      ...prWorkspaceRouteContext,
                      recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                      filter: artifactFilterParamForWorkspaceNav('compare'),
                    },
                  });
                }}
                onOpenRecipe={() => {
                  if (!item.pr.latestRunId) return;
                  router.push({
                    pathname: '/artifacts/[runId]',
                    params: {
                      runId: item.pr.latestRunId,
                      ...prWorkspaceRouteContext,
                      recipeRun: CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
                      filter: artifactFilterParamForWorkspaceNav('recipe'),
                    },
                  });
                }}
                onOpenDiff={() => {
                  if (!item.pr.latestRunId) {
                    if (!item.pr.slot) return;
                    router.push({
                      pathname: '/diff/slot/[slotId]',
                      params: { slotId: item.pr.slot, ...diffRouteContext },
                    });
                    return;
                  }
                  router.push({
                    pathname: '/diff/[runId]',
                    params: {
                      runId: item.pr.latestRunId,
                      ...diffRouteContext,
                      recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                    },
                  });
                }}
                onOpenTerminal={() => {
                  if (!item.pr.slot) return;
                  router.push({
                    pathname: '/terminal/[slotId]',
                    params: {
                      slotId: item.pr.slot,
                      ...prWorkspaceRouteContext,
                      details: '1',
                      ...(item.pr.latestRunId ? { runId: item.pr.latestRunId } : {}),
                      recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                    },
                  });
                }}
                onDispatchComplete={() => handleDispatchComplete(item.pr)}
              />
            )
          }
          contentContainerStyle={[
            styles.listContent,
            { paddingBottom: styles.listContent.paddingBottom + insets.bottom },
          ]}
        />
      )}
    </View>
  );
}

function prDashboardRowKey(row: PRDashboardRow): string {
  return row.kind === 'group' ? `group-${row.group.id}` : `${row.pr.repo}/${row.pr.pr}`;
}

function shortId(value: string): string {
  if (!value) return '-';
  if (value.length <= 10) return value;
  return `${value.slice(0, 8)}…`;
}

function primaryAttentionReason(pr: PRStatus): string | null {
  if (pr.mergeConflict) return 'Merge conflict requires operator attention.';
  if (pr.actionableBotComments.length > 0) {
    return `${pr.actionableBotComments.length} actionable bot comment${pr.actionableBotComments.length === 1 ? '' : 's'}.`;
  }
  if (pr.failedNames.length > 0) return `Failed: ${pr.failedNames.slice(0, 2).join(', ')}`;
  if (pr.allFailedNames?.length) return `Failed: ${pr.allFailedNames.slice(0, 2).join(', ')}`;
  if (pr.anyFailed) return 'One or more watched checks failed.';
  return null;
}

function SummaryPill({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <View style={[styles.summaryPill, { borderColor: color + '66' }]}>
      <Text style={[styles.summaryValue, { color }]}>{value}</Text>
      <Text style={styles.summaryLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  emptyContainer: {
    flex: 1,
    gap: spacing.xl,
    justifyContent: 'flex-start',
    padding: spacing.lg,
  },
  listContent: { padding: spacing.lg, paddingBottom: spacing.xxxl },
  headerContent: { gap: spacing.md, marginBottom: spacing.lg },
  screenTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeXl,
    fontWeight: '900',
  },
  titleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  summaryRow: { alignItems: 'stretch', flexDirection: 'row', gap: spacing.sm },
  summaryPill: {
    backgroundColor: colors.bgCard,
    borderRadius: radii.md,
    borderWidth: 1,
    flex: 1,
    padding: spacing.md,
  },
  summaryValue: { fontSize: fonts.sizeLg, fontWeight: '900' },
  summaryLabel: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
    marginTop: spacing.xs,
    textTransform: 'uppercase',
  },
  scopeText: { color: colors.textMuted, fontSize: fonts.sizeXs, lineHeight: 16 },
  scopeCard: {
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    gap: spacing.xs,
    padding: spacing.md,
  },
  scopeTitle: {
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  scopeMeta: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    lineHeight: 16,
  },
  scopeActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  scopeActionButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  focusCard: {
    backgroundColor: colors.accent + '18',
    borderColor: colors.accent + '55',
    borderRadius: radii.md,
    borderWidth: 1,
    gap: spacing.xs,
    padding: spacing.md,
  },
  focusTitle: {
    color: colors.accent,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
  },
  focusMeta: {
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
    lineHeight: 16,
  },
  filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  filterChip: {
    backgroundColor: colors.bgInput,
    borderColor: colors.bgCard,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  filterChipActive: {
    backgroundColor: colors.accent + '22',
    borderColor: colors.accent + '66',
  },
  filterText: { color: colors.textMuted, fontSize: fonts.sizeXs, fontWeight: '900' },
  filterTextActive: { color: colors.accent },
  sortRow: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  sortLabel: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  sortChip: {
    backgroundColor: colors.bgInput,
    borderColor: colors.bgCard,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  sortChipActive: {
    backgroundColor: colors.accent + '22',
    borderColor: colors.accent + '66',
  },
  sortText: { color: colors.textMuted, fontSize: fonts.sizeXs, fontWeight: '900' },
  sortTextActive: { color: colors.accent },
  errorText: { color: colors.statusFail, fontSize: fonts.sizeSm },
  groupHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.sm,
    marginTop: spacing.sm,
  },
  groupHeaderText: {
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  groupHeaderCount: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  prCard: {
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCard,
    borderRadius: radii.md,
    borderWidth: 1,
    gap: spacing.md,
    marginBottom: spacing.md,
    padding: spacing.lg,
  },
  attentionCard: { borderColor: colors.statusFail + '66' },
  topRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.md },
  prNumber: { color: colors.accent, fontSize: fonts.sizeMd, fontWeight: '900' },
  recommendationBadge: {
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  recommendationText: {
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  slotText: { color: colors.textMuted, flex: 1, fontSize: fonts.sizeXs, textAlign: 'right' },
  prTitle: { color: colors.textPrimary, fontSize: fonts.sizeMd, fontWeight: '800' },
  issueText: { color: colors.statusWarn, fontSize: fonts.sizeSm, fontWeight: '700' },
  ciBar: {
    backgroundColor: colors.bgInput,
    borderRadius: 3,
    flexDirection: 'row',
    height: 6,
    overflow: 'hidden',
  },
  ciSegment: { height: '100%' },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.xs,
    paddingRight: spacing.md,
  },
  actionButton: {
    backgroundColor: colors.bgInput,
    borderColor: colors.bgInput,
    borderRadius: radii.md,
    borderWidth: 1,
    minWidth: 104,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  primaryAction: {
    backgroundColor: colors.accent + '22',
    borderColor: colors.accent + '66',
  },
  actionDisabled: { opacity: 0.5 },
  actionText: { color: colors.textSecondary, fontSize: fonts.sizeXs, fontWeight: '900' },
  actionValue: {
    color: colors.textPrimary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    marginTop: 2,
  },
  primaryActionText: { color: colors.accent },
  headerRefreshButton: {
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 86,
    paddingVertical: spacing.xs,
  },
  refreshButton: { alignSelf: 'center', marginTop: spacing.sm },
});
