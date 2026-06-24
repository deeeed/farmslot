import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { isTerminalRunStatus, normalizeRunTags, type Run } from '@farmslot/protocol';
import { FLOW_COLORS, FLOW_LABELS, RUNNER_COLORS } from '@farmslot/theme';

import { BeforeAfterPreview } from '../../components/BeforeAfterPreview';
import { FilterEmptyState } from '../../components/FilterEmptyState';
import { RunFiltersSheet } from '../../components/RunFiltersSheet';
import { RunPipelineMini } from '../../components/RunPipeline';
import {
  type ArtifactHttpHeaders,
  artifactUrlForEntry,
  CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
  DECISION_EVIDENCE_RECIPE_RUN_PARAM,
  extractRunArtifactManifest,
  groupVisualArtifactPairs,
} from '../../lib/artifact-url';
import { diffArtifactCandidate } from '../../lib/diff';
import { prRepoFromWorkspaceSource } from '../../lib/pr-links';
import {
  type RunEvidenceSignal,
  runEvidenceSignalRouteTarget,
  summarizeRunEvidenceSignals,
} from '../../lib/run-evidence-signals';
import {
  groupRunsByFamily,
  type RunFamilyGroup,
  selectRecentRunFamilyGroups,
} from '../../lib/run-family-groups';
import { baseStyles, colors, fonts, radii, spacing } from '../../lib/theme';
import {
  selectReadyWorkspaceDecision,
  selectRetrospectiveWorkspaceDecision,
  selectReviewGateWorkspaceDecision,
} from '../../lib/workspace-decisions';
import {
  artifactFilterParamForWorkspaceNav,
  familySectionRouteContextParams,
  targetWorkspaceRouteContextParams,
} from '../../lib/workspace-navigation';
import { useConnectionStore } from '../../store/connection';
import { filterRuns, useFilterStore } from '../../store/filters';
import { useFleetStore } from '../../store/fleet';
import { useRunFilterStore } from '../../store/run-filters';
import { useRunStore } from '../../store/runs';

const STATUS_COLORS: Record<string, string> = {
  done: colors.statusOk,
  failed: colors.statusFail,
  cancelled: colors.statusWarn,
  monitoring: colors.lifecycleWorking,
  preparing: colors.lifecycleDispatching,
  dispatching: colors.lifecycleDispatching,
  paused: colors.statusWarn,
};
const DIFF_ROUTE_CONTEXT = targetWorkspaceRouteContextParams('diff');

function formatDuration(ms: number | undefined): string {
  if (!ms) return '';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function relativeTime(dateStr: string | null | undefined): string {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

type RunsListRow =
  | { kind: 'family'; group: RunFamilyGroup; familyIndex: number; familyCount: number }
  | {
      kind: 'run';
      run: Run;
      familyRunIndex: number;
      familyRunCount: number;
      isFamilyRoot: boolean;
      isLastFamilyRun: boolean;
    };

function RunCard({
  run,
  familyRunIndex,
  familyRunCount,
  isFamilyRoot,
  isLastFamilyRun,
  gatewayUrl,
  artifactAuthHeaders,
}: {
  run: Run;
  familyRunIndex: number;
  familyRunCount: number;
  isFamilyRoot: boolean;
  isLastFamilyRun: boolean;
  gatewayUrl: string;
  artifactAuthHeaders: ArtifactHttpHeaders;
}) {
  const router = useRouter();
  const statusColor = STATUS_COLORS[run.status] ?? colors.accent;
  const artifactManifest = extractRunArtifactManifest(run);
  const artifactCount = artifactManifest.length;
  const visualPairSummary = groupVisualArtifactPairs(artifactManifest, (artifact) =>
    artifactUrlForEntry(gatewayUrl, run.id, artifact),
  );
  const primaryVisualPair = visualPairSummary.pairs[0] ?? null;
  const diffArtifactPath = diffArtifactCandidate(artifactManifest)?.path ?? null;
  const readyDecision = selectReadyWorkspaceDecision(run);
  const reviewGateDecision = selectReviewGateWorkspaceDecision(run);
  const retroDecision = selectRetrospectiveWorkspaceDecision(run);
  const canOpenDiff = Boolean(diffArtifactPath || run.slotId);
  const runPositionLabel =
    familyRunCount === 1
      ? 'Only run'
      : isFamilyRoot
        ? 'Root run'
        : `Child run ${familyRunIndex + 1}/${familyRunCount}`;

  return (
    <View style={[styles.familyRunRow, isLastFamilyRun && styles.familyRunRowLast]}>
      <View style={styles.familyRunRail}>
        <View style={[styles.familyRunDot, isFamilyRoot && styles.familyRunDotRoot]} />
        <View
          style={[
            styles.familyRunLine,
            familyRunIndex === familyRunCount - 1 && styles.familyRunLineLast,
          ]}
        />
      </View>
      <Pressable
        style={[styles.runCard, isFamilyRoot && styles.rootRunCard]}
        onPress={() =>
          router.push({
            pathname: '/run/[id]',
            params: { id: run.id, recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM },
          })
        }
      >
        <View style={styles.row}>
          <View style={styles.runBadgeRow}>
            <View style={styles.familyRunPositionBadge}>
              <Text style={styles.familyRunPositionText}>{runPositionLabel}</Text>
            </View>
            <View
              style={[
                styles.flowBadge,
                {
                  backgroundColor: (FLOW_COLORS[run.flowType] ?? colors.textMuted) + '30',
                },
              ]}
            >
              <Text
                style={[styles.badgeText, { color: FLOW_COLORS[run.flowType] ?? colors.textMuted }]}
              >
                {FLOW_LABELS[run.flowType] ?? run.flowType}
              </Text>
            </View>
            {run.metrics?.runner ? (
              <View
                style={[
                  styles.flowBadge,
                  {
                    backgroundColor: (RUNNER_COLORS[run.metrics.runner] ?? colors.textMuted) + '30',
                  },
                ]}
              >
                <Text
                  style={[
                    styles.badgeText,
                    { color: RUNNER_COLORS[run.metrics.runner] ?? colors.textMuted },
                  ]}
                >
                  {run.metrics.runner}
                </Text>
              </View>
            ) : null}
          </View>
          <View style={[styles.statusBadge, { backgroundColor: statusColor + '30' }]}>
            <Text style={[styles.badgeText, { color: statusColor }]}>{run.status}</Text>
          </View>
        </View>
        <Text style={styles.ticketText} numberOfLines={1}>
          {run.ticketOrPr}
        </Text>
        {normalizeRunTags(run.tags).length > 0 ? (
          <View style={styles.tagRow}>
            {normalizeRunTags(run.tags).map((tag) => (
              <Text key={tag} style={styles.tagChip}>
                #{tag}
              </Text>
            ))}
          </View>
        ) : null}
        <View style={styles.metaRow}>
          {run.slotId && <Text style={baseStyles.textMuted}>{run.slotId}</Text>}
          {run.metrics?.durationMs != null && (
            <Text style={baseStyles.textMuted}>{formatDuration(run.metrics.durationMs)}</Text>
          )}
        </View>
        {(run.steps ?? []).length > 0 && (
          <RunPipelineMini steps={run.steps} runStatus={run.status} />
        )}
        {primaryVisualPair ? (
          <View style={styles.runComparePreview}>
            <BeforeAfterPreview
              pair={primaryVisualPair}
              authHeaders={artifactAuthHeaders}
              onOpenArtifact={(artifactPath) =>
                router.push({
                  pathname: '/artifacts/[runId]',
                  params: {
                    runId: run.id,
                    recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                    filter: artifactFilterParamForWorkspaceNav('compare'),
                    artifact: artifactPath,
                  },
                })
              }
              eyebrow="Run evidence"
              title="Before → after"
              hint={`${visualPairSummary.pairs.length} pair${
                visualPairSummary.pairs.length === 1 ? '' : 's'
              }`}
              imageHeight={54}
            />
          </View>
        ) : null}
        <RunEvidenceSignals run={run} />
        <View style={styles.quickActionRow}>
          <RunQuickAction
            label="Family"
            onPress={() =>
              router.push({
                pathname: '/family/[familyId]',
                params: {
                  familyId: run.familyId,
                  project: run.project,
                  runId: run.id,
                  ...familySectionRouteContextParams('focus'),
                  section: 'focus',
                },
              })
            }
          />
          <RunQuickAction
            label={artifactCount > 0 ? `Evidence ${artifactCount}` : 'Evidence files'}
            onPress={() =>
              router.push({
                pathname: '/artifacts/[runId]',
                params: {
                  runId: run.id,
                  recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  filter: artifactFilterParamForWorkspaceNav('review'),
                },
              })
            }
          />
          <RunQuickAction
            label="Recipe files"
            onPress={() =>
              router.push({
                pathname: '/artifacts/[runId]',
                params: {
                  runId: run.id,
                  recipeRun: CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
                  filter: artifactFilterParamForWorkspaceNav('recipe'),
                },
              })
            }
          />
          {readyDecision ? (
            <RunQuickAction
              label="Ready gate"
              onPress={() =>
                router.push({
                  pathname: '/decision/[id]',
                  params: { id: readyDecision.id, runId: run.id },
                })
              }
            />
          ) : null}
          {reviewGateDecision ? (
            <RunQuickAction
              label="Review gate"
              onPress={() =>
                router.push({
                  pathname: '/decision/[id]',
                  params: { id: reviewGateDecision.id, runId: run.id },
                })
              }
            />
          ) : null}
          {retroDecision ? (
            <RunQuickAction
              label="Retro gate"
              onPress={() =>
                router.push({
                  pathname: '/decision/[id]',
                  params: { id: retroDecision.id, runId: run.id },
                })
              }
            />
          ) : null}
          {run.prNumber ? (
            <RunQuickAction
              label={`PR #${run.prNumber}`}
              onPress={() => {
                const prRepo = prRepoFromWorkspaceSource(run, run.prNumber);
                router.push({
                  pathname: '/(tabs)/prs',
                  params: {
                    pr: String(run.prNumber),
                    ...(prRepo ? { repo: prRepo } : {}),
                  },
                });
              }}
            />
          ) : null}
          {canOpenDiff ? (
            <RunQuickAction
              label="Diff view"
              onPress={() =>
                router.push({
                  pathname: '/diff/[runId]',
                  params: {
                    runId: run.id,
                    ...DIFF_ROUTE_CONTEXT,
                    recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                    ...(diffArtifactPath ? { path: diffArtifactPath } : {}),
                  },
                })
              }
            />
          ) : null}
          {run.slotId ? (
            <>
              <RunQuickAction
                label="Slot"
                onPress={() =>
                  router.push({
                    pathname: '/slot/[id]',
                    params: {
                      id: run.slotId!,
                      runId: run.id,
                      recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                    },
                  })
                }
              />
              <RunQuickAction
                label="Terminal"
                onPress={() =>
                  router.push({
                    pathname: '/terminal/[slotId]',
                    params: {
                      slotId: run.slotId!,
                      runId: run.id,
                      details: '1',
                      recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                    },
                  })
                }
              />
            </>
          ) : null}
        </View>
      </Pressable>
    </View>
  );
}

function RunEvidenceSignals({ run, compact = false }: { run: Run; compact?: boolean }) {
  const router = useRouter();
  const signals = summarizeRunEvidenceSignals(run);
  if (signals.length === 0) return null;

  const openSignal = (signal: RunEvidenceSignal) => {
    const target = runEvidenceSignalRouteTarget(signal);
    router.push({
      pathname: '/family/[familyId]',
      params: {
        familyId: run.familyId,
        project: run.project,
        runId: run.id,
        ...familySectionRouteContextParams(target.section),
        ...target,
      },
    });
  };

  return (
    <View style={[styles.evidenceSignalRow, compact && styles.evidenceSignalRowCompact]}>
      <Text style={styles.evidenceSignalEyebrow}>Review signals</Text>
      {signals.map((signal) => (
        <Pressable
          key={signal.kind}
          accessibilityLabel={signal.title}
          style={[
            styles.evidenceSignalChip,
            signal.kind === 'video' ? styles.videoSignalChip : styles.compareSignalChip,
          ]}
          onPress={() => openSignal(signal)}
        >
          <Text
            style={[
              styles.evidenceSignalText,
              signal.kind === 'video' ? styles.videoSignalText : styles.compareSignalText,
            ]}
          >
            {signal.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function FamilyHeader({
  group,
  familyIndex,
  familyCount,
}: {
  group: RunFamilyGroup;
  familyIndex: number;
  familyCount: number;
}) {
  const router = useRouter();
  const latestRunId = group.representativeRun.id;
  const retrospectiveTone = group.pendingRetrospectiveCount ? colors.statusWarn : colors.statusOk;
  const retrospectiveLabel = familyRetrospectiveLabel(group);
  return (
    <View style={[styles.familySectionHeader, familyIndex > 0 && styles.familySectionHeaderGap]}>
      <View style={styles.familyAccentStrip} />
      <View style={styles.familyHeaderTop}>
        <View style={styles.familyTitleBlock}>
          <View style={styles.familyEyebrowRow}>
            <Text style={styles.familyEyebrow}>
              Family {familyIndex + 1}/{familyCount}
            </Text>
            <Text style={styles.familyRunCountPill}>
              {group.runs.length} run{group.runs.length === 1 ? '' : 's'}
            </Text>
            {retrospectiveLabel ? (
              <Text
                style={[
                  styles.familyRetrospectivePill,
                  {
                    backgroundColor: retrospectiveTone + '22',
                    borderColor: retrospectiveTone + '66',
                    color: retrospectiveTone,
                  },
                ]}
              >
                {retrospectiveLabel}
              </Text>
            ) : null}
            <Text style={styles.familyIdPill}>family:{shortId(group.familyId)}</Text>
          </View>
          <Text style={styles.familyTitle} numberOfLines={1}>
            {group.familyRootTicketOrPr}
          </Text>
          <Text style={styles.familyMeta} numberOfLines={1}>
            Runs below share this family
            {group.activeCount ? ` · ${group.activeCount} active` : ''}
            {group.comparisonCount ? ` · ${group.comparisonCount} comparison` : ''}
            {group.pendingRetrospectiveCount
              ? ` · ${group.pendingRetrospectiveCount} pending retro`
              : group.retrospectiveCount
                ? ` · ${group.retrospectiveCount} retro recorded`
                : ''}
            {group.variants.length ? ` · variants ${group.variants.join(', ')}` : ''}
            {group.latestCreatedAt ? ` · ${relativeTime(group.latestCreatedAt)}` : ''}
          </Text>
        </View>
        <View style={styles.familyHeaderActions}>
          <Pressable
            style={styles.familyOpenButton}
            onPress={() =>
              router.push({
                pathname: '/family/[familyId]',
                params: {
                  familyId: group.familyId,
                  project: group.project,
                  runId: latestRunId,
                  ...familySectionRouteContextParams('focus'),
                  section: 'focus',
                },
              })
            }
          >
            <Text style={styles.familyOpenText}>Open family</Text>
          </Pressable>
        </View>
      </View>
      {group.familySummary ? (
        <Text style={styles.familySummary} numberOfLines={1}>
          {group.familySummary}
        </Text>
      ) : null}
    </View>
  );
}

function familyRetrospectiveLabel(group: RunFamilyGroup): string | null {
  if (group.pendingRetrospectiveCount > 0) {
    return `${group.pendingRetrospectiveCount} retro pending`;
  }
  if (group.retrospectiveCount > 0) {
    return `${group.retrospectiveCount} retro`;
  }
  return null;
}

function RunQuickAction({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable style={styles.quickActionButton} onPress={onPress}>
      <Text style={styles.quickActionText}>{label}</Text>
    </Pressable>
  );
}

function RecentFamilyShortcut({
  group,
  gatewayUrl,
  artifactAuthHeaders,
}: {
  group: RunFamilyGroup;
  gatewayUrl: string;
  artifactAuthHeaders: ArtifactHttpHeaders;
}) {
  const router = useRouter();
  const run = group.representativeRun;
  const artifactManifest = extractRunArtifactManifest(run);
  const visualPairSummary = groupVisualArtifactPairs(artifactManifest, (artifact) =>
    artifactUrlForEntry(gatewayUrl, run.id, artifact),
  );
  const primaryVisualPair = visualPairSummary.pairs[0] ?? null;
  const diffArtifactPath = diffArtifactCandidate(artifactManifest)?.path ?? null;
  const canOpenDiff = Boolean(diffArtifactPath || run.slotId);
  const readyDecision = selectReadyWorkspaceDecision(run);
  const reviewGateDecision = selectReviewGateWorkspaceDecision(run);
  const retroDecision = selectRetrospectiveWorkspaceDecision(run);

  return (
    <View style={styles.recentFamilyCard}>
      <View style={styles.recentFamilyHeader}>
        <View style={styles.recentFamilyTitleBlock}>
          <Text style={styles.familyEyebrow}>
            {group.runs.length} run{group.runs.length === 1 ? '' : 's'} ·{' '}
            {relativeTime(group.latestCreatedAt)}
          </Text>
          <Text style={styles.recentFamilyTitle} numberOfLines={2}>
            {group.familyRootTicketOrPr}
          </Text>
        </View>
        <Pressable
          style={styles.familyOpenButton}
          onPress={() =>
            router.push({
              pathname: '/family/[familyId]',
              params: {
                familyId: group.familyId,
                project: run.project,
                runId: run.id,
                ...familySectionRouteContextParams('focus'),
                section: 'focus',
              },
            })
          }
        >
          <Text style={styles.familyOpenText}>Family</Text>
        </Pressable>
      </View>
      {group.familySummary ? (
        <Text style={styles.familySummary} numberOfLines={2}>
          {group.familySummary}
        </Text>
      ) : null}
      {primaryVisualPair ? (
        <View style={styles.runComparePreview}>
          <BeforeAfterPreview
            pair={primaryVisualPair}
            authHeaders={artifactAuthHeaders}
            onOpenArtifact={(artifactPath) =>
              router.push({
                pathname: '/artifacts/[runId]',
                params: {
                  runId: run.id,
                  recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  filter: artifactFilterParamForWorkspaceNav('compare'),
                  artifact: artifactPath,
                },
              })
            }
            eyebrow="Recent evidence"
            title="Before → after"
            hint={`${visualPairSummary.pairs.length} pair${
              visualPairSummary.pairs.length === 1 ? '' : 's'
            }`}
            imageHeight={54}
          />
        </View>
      ) : null}
      <RunEvidenceSignals run={run} compact />
      <View style={styles.quickActionRow}>
        {run.slotId ? (
          <>
            <RunQuickAction
              label="Slot"
              onPress={() =>
                router.push({
                  pathname: '/slot/[id]',
                  params: {
                    id: run.slotId!,
                    runId: run.id,
                    recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  },
                })
              }
            />
            <RunQuickAction
              label="Terminal"
              onPress={() =>
                router.push({
                  pathname: '/terminal/[slotId]',
                  params: {
                    slotId: run.slotId!,
                    runId: run.id,
                    details: '1',
                    recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  },
                })
              }
            />
          </>
        ) : null}
        <RunQuickAction
          label={artifactManifest.length ? `Evidence ${artifactManifest.length}` : 'Evidence files'}
          onPress={() =>
            router.push({
              pathname: '/artifacts/[runId]',
              params: {
                runId: run.id,
                recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                filter: artifactFilterParamForWorkspaceNav('review'),
              },
            })
          }
        />
        <RunQuickAction
          label="Recipe files"
          onPress={() =>
            router.push({
              pathname: '/artifacts/[runId]',
              params: {
                runId: run.id,
                recipeRun: CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
                filter: artifactFilterParamForWorkspaceNav('recipe'),
              },
            })
          }
        />
        {canOpenDiff ? (
          <RunQuickAction
            label="Diff view"
            onPress={() =>
              router.push({
                pathname: '/diff/[runId]',
                params: {
                  runId: run.id,
                  ...DIFF_ROUTE_CONTEXT,
                  recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  ...(diffArtifactPath ? { path: diffArtifactPath } : {}),
                },
              })
            }
          />
        ) : null}
        {readyDecision ? (
          <RunQuickAction
            label="Ready"
            onPress={() =>
              router.push({
                pathname: '/decision/[id]',
                params: { id: readyDecision.id, runId: run.id },
              })
            }
          />
        ) : null}
        {reviewGateDecision ? (
          <RunQuickAction
            label="Review"
            onPress={() =>
              router.push({
                pathname: '/decision/[id]',
                params: { id: reviewGateDecision.id, runId: run.id },
              })
            }
          />
        ) : null}
        {retroDecision ? (
          <RunQuickAction
            label="Retro"
            onPress={() =>
              router.push({
                pathname: '/decision/[id]',
                params: { id: retroDecision.id, runId: run.id },
              })
            }
          />
        ) : null}
      </View>
    </View>
  );
}

function NoActiveRunsWorkspace({
  recentFamilies,
  onShowCompleted,
  bottomInset,
  gatewayUrl,
  artifactAuthHeaders,
}: {
  recentFamilies: RunFamilyGroup[];
  onShowCompleted: () => void;
  bottomInset: number;
  gatewayUrl: string;
  artifactAuthHeaders: ArtifactHttpHeaders;
}) {
  return (
    <ScrollView
      style={styles.emptyWorkspaceScroll}
      contentContainerStyle={[
        styles.emptyWorkspaceContent,
        { paddingBottom: styles.emptyWorkspaceContent.paddingBottom + bottomInset },
      ]}
    >
      <View style={styles.emptyWorkspaceHero}>
        <Text style={styles.emptyWorkspaceTitle}>No active runs</Text>
        <Text style={styles.emptyWorkspaceCopy}>
          Recent family workspaces are still available for review, artifacts, recipe evidence, and
          diffs.
        </Text>
        <Pressable style={styles.emptyActionButton} onPress={onShowCompleted}>
          <Text style={styles.emptyActionText}>Show completed runs</Text>
        </Pressable>
      </View>
      {recentFamilies.length > 0 ? (
        <View style={styles.recentFamiliesBlock}>
          <Text style={styles.recentFamiliesTitle}>Recent workspaces</Text>
          {recentFamilies.map((group) => (
            <RecentFamilyShortcut
              key={group.familyId}
              group={group}
              gatewayUrl={gatewayUrl}
              artifactAuthHeaders={artifactAuthHeaders}
            />
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}

export default function RunsScreen() {
  const insets = useSafeAreaInsets();
  const runs = useRunStore((s) => s.runs);
  const activeLoading = useRunStore((s) => s.activeLoading);
  const historyLoading = useRunStore((s) => s.historyLoading);
  const status = useConnectionStore((s) => s.status);
  const lastSyncError = useConnectionStore((s) => s.lastSyncError);
  const syncRunHistory = useConnectionStore((s) => s.syncRunHistory);
  const gatewayUrl = useConnectionStore((s) => s.gatewayUrl);
  const artifactAuthHeaders = useConnectionStore((s) => s.activeProfileHttpAuthHeaders);
  const filters = useFilterStore((s) => s.filters);
  const clearFilters = useFilterStore((s) => s.clearAll);
  const fleet = useFleetStore((s) => s.fleet);
  const runFilters = useRunFilterStore((s) => s.filters);
  const runFilterCount = useRunFilterStore((s) => s.activeCount)();
  const initRunFilters = useRunFilterStore((s) => s.init);
  const [showAllRuns, setShowAllRuns] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const hasFilters = filters.projects.length > 0 || filters.machines.length > 0;

  useEffect(() => {
    void initRunFilters();
  }, [initRunFilters]);

  const openHistory = useCallback(() => {
    setShowAllRuns(true);
    void syncRunHistory();
  }, [syncRunHistory]);

  useEffect(() => {
    if (status !== 'connected' || !showAllRuns || activeLoading) return;
    void syncRunHistory();
  }, [activeLoading, showAllRuns, status, syncRunHistory]);

  const toggleHistoryScope = useCallback(() => {
    if (showAllRuns) {
      setShowAllRuns(false);
      return;
    }
    openHistory();
  }, [openHistory, showAllRuns]);

  const runsSyncMessage = historyLoading
    ? 'Downloading run history…'
    : activeLoading
      ? 'Downloading active runs…'
      : null;

  const slotById = useMemo(
    () =>
      new Map(
        (fleet?.slots ?? []).map(
          (slot) => [slot.slot, { project: slot.project, machine: slot.machine }] as const,
        ),
      ),
    [fleet],
  );
  const filteredRuns = useMemo(
    () => filterRuns(runs, filters, slotById),
    [filters, runs, slotById],
  );
  const activeRuns = useMemo(
    () => filteredRuns.filter((run) => !isTerminalRunStatus(run.status)),
    [filteredRuns],
  );
  const localFilteredRuns = useMemo(() => {
    let result = showAllRuns ? filteredRuns : activeRuns;
    if (runFilters.flow) {
      result = result.filter((r) => r.flowType === runFilters.flow);
    }
    if (runFilters.lane) {
      result = result.filter((r) => r.lane === runFilters.lane);
    }
    if (runFilters.tag.trim()) {
      const [tag] = normalizeRunTags([runFilters.tag]);
      result = tag ? result.filter((r) => normalizeRunTags(r.tags).includes(tag)) : result;
    }
    if (runFilters.search.trim()) {
      const q = runFilters.search.trim().toLowerCase();
      result = result.filter(
        (r) =>
          r.ticketOrPr.toLowerCase().includes(q) ||
          (r.summary ?? '').toLowerCase().includes(q) ||
          (r.slotId ?? '').toLowerCase().includes(q) ||
          normalizeRunTags(r.tags).some((tag) => tag.includes(q)),
      );
    }
    if (runFilters.sort === 'oldest') {
      result = [...result].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );
    } else if (runFilters.sort === 'duration') {
      result = [...result].sort(
        (a, b) => (b.metrics?.durationMs ?? 0) - (a.metrics?.durationMs ?? 0),
      );
    }
    return result;
  }, [showAllRuns, filteredRuns, activeRuns, runFilters]);
  const visibleRuns = localFilteredRuns;
  const recentFamilyShortcuts = useMemo(
    () => selectRecentRunFamilyGroups(filteredRuns, 3),
    [filteredRuns],
  );

  const runRows = useMemo<RunsListRow[]>(() => {
    const groups = groupRunsByFamily(visibleRuns);
    return groups.flatMap((group, familyIndex) => [
      { kind: 'family' as const, group, familyIndex, familyCount: groups.length },
      ...group.runs.map((run, index) => ({
        kind: 'run' as const,
        run,
        familyRunIndex: index,
        familyRunCount: group.runs.length,
        isFamilyRoot: run.id === group.familyId || run.parentRunId == null,
        isLastFamilyRun: index === group.runs.length - 1,
      })),
    ]);
  }, [visibleRuns]);

  const runScopeHeader = (
    <View style={styles.scopeBar}>
      <View style={styles.scopeTextBlock}>
        <Text style={styles.scopeTitle}>{showAllRuns ? 'Review history' : 'Review queue'}</Text>
        <Text style={styles.scopeMeta}>
          {activeRuns.length} active package{activeRuns.length === 1 ? '' : 's'} ·{' '}
          {filteredRuns.length} total
          {hasFilters ? ' · filtered' : ''}
        </Text>
      </View>
      <View style={styles.scopeActions}>
        <Pressable
          style={[styles.scopeToggle, runFilterCount > 0 && styles.scopeToggleActive]}
          onPress={() => setFiltersOpen(true)}
        >
          <Text
            style={[styles.scopeToggleText, runFilterCount > 0 && styles.scopeToggleTextActive]}
          >
            {runFilterCount > 0 ? `Refine (${runFilterCount})` : 'Refine'}
          </Text>
        </Pressable>
        <Pressable style={styles.scopeToggle} onPress={toggleHistoryScope}>
          <Text style={styles.scopeToggleText}>{showAllRuns ? 'Active' : 'History'}</Text>
        </Pressable>
      </View>
    </View>
  );

  const renderRow = useCallback(
    ({ item }: { item: RunsListRow }) =>
      item.kind === 'family' ? (
        <FamilyHeader
          group={item.group}
          familyIndex={item.familyIndex}
          familyCount={item.familyCount}
        />
      ) : (
        <RunCard
          run={item.run}
          familyRunIndex={item.familyRunIndex}
          familyRunCount={item.familyRunCount}
          isFamilyRoot={item.isFamilyRoot}
          isLastFamilyRun={item.isLastFamilyRun}
          gatewayUrl={gatewayUrl}
          artifactAuthHeaders={artifactAuthHeaders}
        />
      ),
    [artifactAuthHeaders, gatewayUrl],
  );

  return (
    <View style={baseStyles.container}>
      {status === 'connected' ? runScopeHeader : null}
      {runRows.length === 0 ? (
        status === 'connected' && runsSyncMessage ? (
          <View style={[styles.emptyContainer, { paddingBottom: insets.bottom }]}>
            <ActivityIndicator size="large" color={colors.accent} />
            <Text style={[baseStyles.textSecondary, styles.syncEmptyText]}>{runsSyncMessage}</Text>
          </View>
        ) : status === 'connected' && hasFilters && (showAllRuns || filteredRuns.length === 0) ? (
          <FilterEmptyState
            message={
              showAllRuns
                ? 'No runs match the active filters.'
                : 'No active runs match the active filters.'
            }
            onClear={clearFilters}
            style={{ flex: 1, paddingBottom: insets.bottom }}
          />
        ) : status === 'connected' && !showAllRuns && filteredRuns.length > 0 ? (
          <NoActiveRunsWorkspace
            recentFamilies={recentFamilyShortcuts}
            onShowCompleted={openHistory}
            bottomInset={insets.bottom}
            gatewayUrl={gatewayUrl}
            artifactAuthHeaders={artifactAuthHeaders}
          />
        ) : status === 'connected' && lastSyncError && !runsSyncMessage ? (
          <View style={[styles.emptyContainer, { paddingBottom: insets.bottom }]}>
            <Text style={baseStyles.textSecondary}>{lastSyncError}</Text>
          </View>
        ) : (
          <View style={[styles.emptyContainer, { paddingBottom: insets.bottom }]}>
            <Text style={baseStyles.textSecondary}>
              {status === 'connected'
                ? showAllRuns
                  ? 'No runs found'
                  : 'No active runs'
                : 'Connect to gateway to see runs'}
            </Text>
          </View>
        )
      ) : (
        <FlashList
          data={runRows}
          keyExtractor={(item) =>
            item.kind === 'family' ? `family:${item.group.familyId}` : `run:${item.run.id}`
          }
          renderItem={renderRow}
          contentContainerStyle={[
            styles.listContent,
            { paddingBottom: styles.listContent.paddingBottom + insets.bottom },
          ]}
        />
      )}
      <RunFiltersSheet open={filtersOpen} onClose={() => setFiltersOpen(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: spacing.md },
  syncEmptyText: {
    marginTop: spacing.sm,
    textAlign: 'center',
  },
  emptyWorkspaceScroll: {
    flex: 1,
  },
  emptyWorkspaceContent: {
    padding: spacing.lg,
    paddingBottom: spacing.xxxl,
  },
  emptyWorkspaceHero: {
    alignItems: 'flex-start',
    backgroundColor: colors.bgSurface,
    borderColor: colors.bgCard,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.lg,
  },
  emptyWorkspaceTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeLg,
    fontWeight: '900',
  },
  emptyWorkspaceCopy: {
    color: colors.textSecondary,
    fontSize: fonts.sizeSm,
    lineHeight: 19,
  },
  emptyActionButton: {
    backgroundColor: colors.accent + '18',
    borderColor: colors.accent + '66',
    borderRadius: 999,
    borderWidth: 1,
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  emptyActionText: {
    color: colors.accent,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
  },
  listContent: { padding: spacing.lg, paddingBottom: spacing.xxxl },
  scopeBar: {
    alignItems: 'center',
    backgroundColor: colors.bgSurface,
    borderBottomColor: colors.bgCard,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  scopeTextBlock: {
    flex: 1,
    minWidth: 0,
  },
  scopeTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
    fontWeight: '900',
  },
  scopeMeta: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '700',
    marginTop: 2,
    textTransform: 'uppercase',
  },
  scopeActions: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  scopeToggle: {
    backgroundColor: colors.accent + '18',
    borderColor: colors.accent + '66',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  scopeToggleActive: {
    backgroundColor: colors.statusOk + '22',
    borderColor: colors.statusOk + '88',
  },
  scopeToggleText: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  scopeToggleTextActive: {
    color: colors.statusOk,
  },
  familySectionHeader: {
    backgroundColor: colors.bgSurface,
    borderColor: colors.accent + '55',
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.sm,
    marginBottom: 0,
    overflow: 'hidden',
    padding: spacing.md,
    paddingLeft: spacing.xl,
  },
  familySectionHeaderGap: {
    marginTop: spacing.xl,
  },
  familyAccentStrip: {
    backgroundColor: colors.accent,
    bottom: 0,
    left: 0,
    position: 'absolute',
    top: 0,
    width: 4,
  },
  familyHeaderTop: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  familyTitleBlock: {
    flex: 1,
    minWidth: 0,
  },
  familyHeaderActions: {
    alignItems: 'flex-end',
    gap: spacing.xs,
  },
  familyEyebrowRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  familyEyebrow: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  familyRunCountPill: {
    backgroundColor: colors.accent + '22',
    borderRadius: 999,
    color: colors.textPrimary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    overflow: 'hidden',
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    textTransform: 'uppercase',
  },
  familyRetrospectivePill: {
    borderRadius: 999,
    borderWidth: 1,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    overflow: 'hidden',
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    textTransform: 'uppercase',
  },
  familyIdPill: {
    backgroundColor: colors.bgInput,
    borderColor: colors.bgCardHover,
    borderRadius: 999,
    borderWidth: 1,
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
    overflow: 'hidden',
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    textTransform: 'uppercase',
  },
  familyTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
  },
  familyMeta: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    marginTop: spacing.xs,
    textTransform: 'uppercase',
  },
  familySummary: {
    color: colors.textSecondary,
    fontSize: fonts.sizeSm,
    lineHeight: 16,
  },
  familyOpenButton: {
    backgroundColor: colors.accent + '18',
    borderColor: colors.accent + '66',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  familyOpenText: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  recentFamiliesBlock: {
    gap: spacing.md,
    marginTop: spacing.lg,
  },
  recentFamiliesTitle: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  recentFamilyCard: {
    backgroundColor: colors.bgSurface,
    borderColor: colors.bgCardHover,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.md,
  },
  recentFamilyHeader: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  recentFamilyTitleBlock: {
    flex: 1,
    minWidth: 0,
  },
  recentFamilyTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
    fontWeight: '900',
    marginTop: spacing.xs,
  },
  familyRunRow: {
    backgroundColor: colors.accent + '08',
    borderColor: colors.accent + '22',
    borderTopWidth: 1,
    flexDirection: 'row',
    marginBottom: spacing.sm,
    paddingRight: spacing.sm,
  },
  familyRunRowLast: {
    borderBottomColor: colors.accent + '22',
    borderBottomLeftRadius: radii.lg,
    borderBottomRightRadius: radii.lg,
    borderBottomWidth: 1,
    marginBottom: spacing.xl,
  },
  familyRunRail: {
    alignItems: 'center',
    width: 24,
  },
  familyRunDot: {
    backgroundColor: colors.bgCard,
    borderColor: colors.accent + '88',
    borderRadius: 999,
    borderWidth: 2,
    height: 12,
    marginTop: spacing.xl,
    width: 12,
  },
  familyRunDotRoot: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  familyRunLine: {
    backgroundColor: colors.accent + '44',
    flex: 1,
    marginTop: spacing.xs,
    width: 2,
  },
  familyRunLineLast: {
    backgroundColor: 'transparent',
  },
  runCard: {
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCardHover,
    borderWidth: 1,
    borderRadius: radii.md,
    flex: 1,
    padding: spacing.lg,
  },
  rootRunCard: {
    borderColor: colors.accent + '55',
  },
  runComparePreview: {
    backgroundColor: colors.bgInput,
    borderColor: colors.accent + '24',
    borderRadius: radii.lg,
    borderWidth: 1,
    marginTop: spacing.md,
    padding: spacing.xs,
  },
  evidenceSignalRow: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  evidenceSignalRowCompact: {
    marginTop: spacing.sm,
  },
  evidenceSignalEyebrow: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  evidenceSignalChip: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  videoSignalChip: {
    backgroundColor: colors.statusWarn + '18',
    borderColor: colors.statusWarn + '66',
  },
  compareSignalChip: {
    backgroundColor: colors.accent + '18',
    borderColor: colors.accent + '66',
  },
  evidenceSignalText: {
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  videoSignalText: {
    color: colors.statusWarn,
  },
  compareSignalText: {
    color: colors.accent,
  },
  runBadgeRow: {
    alignItems: 'center',
    flexDirection: 'row',
    flexShrink: 1,
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  familyRunPositionBadge: {
    backgroundColor: colors.bgInput,
    borderColor: colors.accent + '55',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  familyRunPositionText: {
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  flowBadge: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: 4 },
  statusBadge: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: 4 },
  badgeText: { fontSize: fonts.sizeXs, fontWeight: '600' },
  ticketText: {
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
    fontWeight: '600',
    marginTop: spacing.md,
  },
  tagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  tagChip: {
    backgroundColor: colors.accent + '18',
    borderColor: colors.accent + '55',
    borderRadius: 999,
    borderWidth: 1,
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
  },
  quickActionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  quickActionButton: {
    backgroundColor: colors.accent + '14',
    borderColor: colors.accent + '55',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  quickActionText: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
});
