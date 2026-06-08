import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { type LayoutChangeEvent, Pressable, ScrollView, Text, View } from 'react-native';

import {
  type RecipeRunArtifactGroup,
  type Run,
  type TaskProgressStructured,
} from '@farmslot/protocol';

import { BeforeAfterPreview } from '../../../components/BeforeAfterPreview';
import { EvidenceReviewWorkspace } from '../../../components/EvidenceReviewWorkspace';
import { RunWorkspaceNav } from '../../../components/RunWorkspaceNav';
import {
  TaskProgressFallbackPanel,
  TaskProgressPanel,
} from '../../../components/TaskProgressPanel';
import {
  type ArtifactHttpHeaders,
  type ArtifactManifestEntry,
  artifactsForRecipeRun,
  artifactUrlForEntry,
  classifyArtifact,
  CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
  DECISION_EVIDENCE_RECIPE_RUN_PARAM,
  groupVisualArtifactPairs,
  type VisualArtifactPair,
} from '../../../lib/artifact-url';
import {
  type ArtifactWorkspaceCounts,
  type ArtifactWorkspaceFilter,
  artifactWorkspaceFilterPresentation,
  artifactWorkspaceHeaderPresentation,
  filterArtifactWorkspace,
} from '../../../lib/artifact-workspace';
import { diffArtifactCandidate } from '../../../lib/diff';
import { prRepoFromWorkspaceSource } from '../../../lib/pr-links';
import { fallbackTaskProgressSummary, taskProgressPercent } from '../../../lib/task-progress';
import { colors, spacing } from '../../../lib/theme';
import {
  selectPrimaryWorkspaceDecision,
  selectReadyWorkspaceDecision,
  selectRetrospectiveWorkspaceDecision,
  selectReviewGateWorkspaceDecision,
  workspaceDecisionKind,
} from '../../../lib/workspace-decisions';
import { summarizeRunWorkspaceNavMeta } from '../../../lib/workspace-nav-meta';
import {
  artifactFilterParamForWorkspaceNav,
  artifactWorkspaceNavCurrent,
  decisionWorkspaceRouteParams,
  familySectionRouteContextParams,
  recipeWorkspaceParam,
  recipeWorkspaceScopeLabel,
  shouldPreserveArtifactForRecipeContext,
  targetWorkspaceRouteContextParams,
  type WorkspaceRouteContext,
} from '../../../lib/workspace-navigation';
import { artifactViewerStyles as styles } from '../styles/artifact-viewer.styles';

export function routeParamString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
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
export function ArtifactStickyFilter({
  compact = false,
  filter,
  query,
  counts,
  visible,
  visualPairCount,
  filters,
  onFilterChange,
}: {
  compact?: boolean;
  filter: ArtifactWorkspaceFilter;
  query: string;
  counts: ArtifactWorkspaceCounts;
  visible: number;
  visualPairCount: number;
  filters: Array<{ id: ArtifactWorkspaceFilter; label: string }>;
  onFilterChange: (filter: ArtifactWorkspaceFilter) => void;
}) {
  const header = artifactWorkspaceHeaderPresentation({
    activeFilter: filter,
    visible,
    total: counts.all,
    visualPairCount,
  });
  if (compact) {
    return (
      <View style={[styles.stickyFilter, styles.stickyFilterCompact]}>
        <View style={styles.stickyFilterCompactRow}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.stickyFilterCompactChips}
          >
            {filters.map((item) => {
              const active = filter === item.id;
              const presentation = artifactWorkspaceFilterPresentation({
                filter: item.id,
                fallbackLabel: item.label,
                counts,
                visualPairCount,
              });
              return (
                <Pressable
                  key={item.id}
                  style={[
                    styles.filterChip,
                    styles.filterChipCompact,
                    active && styles.filterChipActive,
                  ]}
                  onPress={() => onFilterChange(item.id)}
                >
                  <Text
                    style={[
                      styles.filterText,
                      styles.filterTextCompact,
                      active && styles.filterTextActive,
                    ]}
                  >
                    {presentation.label} {presentation.count}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
          <Text style={styles.stickyFilterCompactCount}>{header.countLabel}</Text>
        </View>
        {query.trim() ? (
          <Text style={styles.stickyFilterCompactQuery} numberOfLines={1}>
            Focus: {query.trim()}
          </Text>
        ) : null}
      </View>
    );
  }
  return (
    <View style={styles.stickyFilter}>
      <View style={styles.filterTopRow}>
        <Text style={styles.filterTitle}>{header.title}</Text>
        <Text style={styles.filterCount}>{header.countLabel}</Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        {filters.map((item) => {
          const active = filter === item.id;
          const presentation = artifactWorkspaceFilterPresentation({
            filter: item.id,
            fallbackLabel: item.label,
            counts,
            visualPairCount,
          });
          return (
            <Pressable
              key={item.id}
              style={[styles.filterChip, active && styles.filterChipActive]}
              onPress={() => onFilterChange(item.id)}
            >
              <Text style={[styles.filterText, active && styles.filterTextActive]}>
                {presentation.label} {presentation.count}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
      {query.trim() ? (
        <Pressable style={styles.focusedFilterPill} onPress={() => onFilterChange(filter)}>
          <Text style={styles.focusedFilterText} numberOfLines={1}>
            Focus: {query.trim()}
          </Text>
          <Text style={styles.focusedFilterClear}>Clear</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
export function ArtifactHeader({
  run,
  gatewayUrl,
  artifactCount,
  runArtifactCount,
  manifest,
  pairs,
  recipeFallbackPairs,
  authHeaders,
  recipeRuns,
  selectedRecipeRunId,
  workspaceRecipeRunId,
  workspaceNavCurrent,
  workspaceRouteContext,
  recipeAvailable,
  diffAvailable,
  focusedArtifactQuery,
  activeFilter,
  artifactCounts,
  filteredArtifactCount,
  visualPairCount,
  availableFilters,
  activeTaskProgress,
  fallbackTaskProgress,
  taskProgressError,
  artifactMirrorEpoch,
  artifactMirrorRefreshing,
  artifactMirrorFeedback,
  onRefreshArtifactMirror,
  onFilterChange,
  onSelectRecipeRun,
  onFocusFilter,
  onOpenVisual,
  onOpenDocument,
  onOpenDiff,
  onOpenArtifactWorkspace,
  onOpenCompareArtifact,
  onWorkspaceNavLayout,
  onClearFocusedArtifact,
}: {
  run: Run;
  gatewayUrl: string;
  artifactCount: number;
  runArtifactCount: number;
  manifest: ArtifactManifestEntry[];
  pairs: VisualArtifactPair[];
  recipeFallbackPairs: VisualArtifactPair[];
  authHeaders: ArtifactHttpHeaders;
  recipeRuns: RecipeRunArtifactGroup[];
  selectedRecipeRunId: string | null;
  workspaceRecipeRunId: string | null;
  workspaceNavCurrent: ReturnType<typeof artifactWorkspaceNavCurrent>;
  workspaceRouteContext: WorkspaceRouteContext;
  recipeAvailable?: boolean;
  diffAvailable: boolean;
  focusedArtifactQuery: string;
  activeFilter: ArtifactWorkspaceFilter;
  artifactCounts: ArtifactWorkspaceCounts;
  filteredArtifactCount: number;
  visualPairCount: number;
  availableFilters: Array<{ id: ArtifactWorkspaceFilter; label: string }>;
  activeTaskProgress: TaskProgressStructured | null;
  fallbackTaskProgress: ReturnType<typeof fallbackTaskProgressSummary> | null;
  taskProgressError: string | null;
  artifactMirrorEpoch: number;
  artifactMirrorRefreshing: boolean;
  artifactMirrorFeedback: string | null;
  onRefreshArtifactMirror: () => void;
  onFilterChange: (filter: ArtifactWorkspaceFilter) => void;
  onSelectRecipeRun: (id: string | null) => void;
  onFocusFilter: (filter: ArtifactWorkspaceFilter) => void;
  onOpenVisual: (uri: string) => void;
  onOpenDocument: (artifact: ArtifactManifestEntry) => void;
  onOpenDiff: (path?: string) => void;
  onOpenArtifactWorkspace: (artifact: ArtifactManifestEntry) => void;
  onOpenCompareArtifact: (artifact: ArtifactManifestEntry, recipeRunId?: string | null) => void;
  onWorkspaceNavLayout: (event: LayoutChangeEvent) => void;
  onClearFocusedArtifact: () => void;
}) {
  const router = useRouter();
  const selectedRecipeRun = recipeRuns.find((group) => group.id === selectedRecipeRunId) ?? null;
  const recipeArtifactCount = recipeRuns.reduce(
    (count, group) => count + artifactsForRecipeRun(group).length,
    0,
  );
  const priorityPair = pairs[0] ?? recipeFallbackPairs[0] ?? null;
  const priorityPairCount = pairs.length > 0 ? pairs.length : recipeFallbackPairs.length;
  const priorityPairIsRecipeFallback = pairs.length === 0 && recipeFallbackPairs.length > 0;
  const priorityRecipeRunId =
    priorityPairIsRecipeFallback && priorityPair
      ? recipeRunIdForVisualPair(recipeRuns, priorityPair, selectedRecipeRunId)
      : workspaceRecipeRunId;
  const diffArtifactPath = diffArtifactCandidate(manifest)?.path ?? null;
  const normalizedFocusedArtifactQuery = focusedArtifactQuery.trim();
  const focusedArtifactPath = manifest.some(
    (artifact) => artifact.path === normalizedFocusedArtifactQuery,
  )
    ? normalizedFocusedArtifactQuery
    : null;
  const focusedArtifact =
    manifest.find((artifact) => artifact.path === focusedArtifactPath) ?? null;
  const primaryDecision = selectPrimaryWorkspaceDecision(run);
  const readyDecision = selectReadyWorkspaceDecision(run);
  const reviewGateDecision = selectReviewGateWorkspaceDecision(run);
  const retroDecision = selectRetrospectiveWorkspaceDecision(run);
  const workspaceNavMeta = summarizeRunWorkspaceNavMeta(run);
  const targetRouteContext = (
    targetWorkspace: Parameters<typeof targetWorkspaceRouteContextParams>[0],
  ) => targetWorkspaceRouteContextParams(targetWorkspace, workspaceRouteContext.decisionKind);
  const reviewWorkspaceArtifacts = useMemo(
    () => filterArtifactWorkspace(manifest, activeFilter, focusedArtifactQuery),
    [activeFilter, focusedArtifactQuery, manifest],
  );
  const reviewWorkspacePairs = useMemo(() => {
    if (focusedArtifactQuery.trim()) return [];
    return activeFilter === 'all' || activeFilter === 'visual' ? pairs : [];
  }, [activeFilter, focusedArtifactQuery, pairs]);
  return (
    <View style={styles.header}>
      <View style={styles.headerRow}>
        <View style={[styles.flowBadge, { backgroundColor: colors.accent + '30' }]}>
          <Text style={[styles.flowText, { color: colors.accent }]}>{run.flowType}</Text>
        </View>
        <View style={styles.headerActions}>
          <Text style={styles.countText}>{artifactCount} artifacts</Text>
          <Pressable
            style={[styles.refreshButton, artifactMirrorRefreshing && styles.refreshButtonDisabled]}
            disabled={artifactMirrorRefreshing}
            onPress={onRefreshArtifactMirror}
          >
            <Text style={styles.refreshButtonText}>
              {artifactMirrorRefreshing ? 'Refreshing…' : artifactMirrorFeedback || 'Refresh'}
            </Text>
          </Pressable>
        </View>
      </View>
      <Text style={styles.ticketText}>{run.ticketOrPr}</Text>
      <View onLayout={onWorkspaceNavLayout} style={styles.primaryWorkspaceNavBlock}>
        <RunWorkspaceNav
          dense
          current={workspaceNavCurrent}
          routeWorkspace={workspaceRouteContext.workspace}
          routeDecisionKind={workspaceRouteContext.decisionKind}
          decisionId={primaryDecision?.id ?? null}
          decisionKind={workspaceDecisionKind(primaryDecision)}
          readyDecisionId={readyDecision?.id ?? null}
          reviewDecisionId={reviewGateDecision?.id ?? null}
          retroDecisionId={retroDecision?.id ?? null}
          readyMeta={workspaceNavMeta.readyMeta}
          reviewMeta={workspaceNavMeta.reviewMeta}
          retroMeta={workspaceNavMeta.retroMeta}
          familyId={run.familyId}
          project={run.project}
          prNumber={run.prNumber}
          prRepo={prRepoFromWorkspaceSource(run, run.prNumber ?? null)}
          slotId={run.slotId}
          runId={run.id}
          recipeRunId={workspaceRecipeRunId}
          recipeAvailable={recipeAvailable}
          recipeArtifactCount={recipeArtifactCount}
          diffAvailable={diffAvailable}
          artifactCount={runArtifactCount}
          artifactPath={focusedArtifactPath}
          visualPairCount={priorityPairCount}
          compareArtifactPath={priorityPair?.after.path ?? null}
          compareRecipeRunId={priorityRecipeRunId}
        />
      </View>
      <ArtifactStickyFilter
        filter={activeFilter}
        query={focusedArtifactQuery}
        counts={artifactCounts}
        visible={filteredArtifactCount}
        visualPairCount={visualPairCount}
        filters={availableFilters}
        onFilterChange={onFilterChange}
      />
      {priorityPair ? (
        <BeforeAfterPriorityPanel
          pair={priorityPair}
          pairCount={priorityPairCount}
          authHeaders={authHeaders}
          eyebrow={priorityPairIsRecipeFallback ? 'Recipe evidence' : 'Review first'}
          title={priorityPairIsRecipeFallback ? 'Recipe before → after' : 'Before → After evidence'}
          copy={
            priorityPairIsRecipeFallback
              ? 'Recipe evidence has the clearest visible delta for this run.'
              : 'Validate what changed before approving the run.'
          }
          onOpenArtifact={(artifactPath) => {
            const target = [priorityPair.before, priorityPair.after].find(
              (entry) => entry.path === artifactPath,
            );
            if (!target) return;
            if (['image', 'video'].includes(classifyArtifact(target))) {
              onOpenVisual(target.url);
              return;
            }
            onOpenCompareArtifact(target, priorityRecipeRunId);
          }}
          onShowVisuals={() => {
            if (priorityPairIsRecipeFallback) {
              onOpenCompareArtifact(priorityPair.after, priorityRecipeRunId);
            } else {
              onFocusFilter('visual');
            }
          }}
          artifactCount={artifactCount}
          recipeArtifactCount={recipeArtifactCount}
          recipeAvailable={recipeAvailable}
          diffValue={diffArtifactPath ? 'artifact' : diffAvailable ? 'workspace' : 'none'}
          slotId={run.slotId}
          familyId={run.familyId}
          prNumber={run.prNumber}
          onOpenEvidence={() => onFocusFilter('all')}
          onOpenRecipe={() => onFocusFilter('recipes')}
          onOpenDiff={() => onOpenDiff(diffArtifactPath ?? undefined)}
          onOpenRun={() => {
            router.push({
              pathname: '/run/[id]',
              params: {
                id: run.id,
                ...targetRouteContext('run'),
                ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
                ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
              },
            });
          }}
          onOpenFamily={() => {
            if (!run.familyId) return;
            router.push({
              pathname: '/family/[familyId]',
              params: {
                familyId: run.familyId,
                project: run.project,
                ...familySectionRouteContextParams('evidence', workspaceRouteContext.decisionKind),
                runId: run.id,
                section: 'evidence',
                ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
                ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
              },
            });
          }}
          onOpenTerminal={() => {
            if (!run.slotId) return;
            router.push({
              pathname: '/terminal/[slotId]',
              params: {
                slotId: run.slotId,
                ...targetRouteContext('terminal'),
                runId: run.id,
                details: '1',
                ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
                ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
              },
            });
          }}
          onOpenPR={() => {
            if (!run.prNumber) return;
            const prRepo = prRepoFromWorkspaceSource(run, run.prNumber);
            router.push({
              pathname: '/(tabs)/prs',
              params: {
                pr: String(run.prNumber),
                ...targetRouteContext('pr'),
                ...(prRepo ? { repo: prRepo } : {}),
              },
            });
          }}
        />
      ) : null}
      {focusedArtifact ? (
        <FocusedArtifactPanel
          run={run}
          artifact={focusedArtifact}
          diffArtifactPath={diffArtifactPath}
          diffAvailable={diffAvailable}
          comparePairCount={priorityPairCount}
          gatewayUrl={gatewayUrl}
          workspaceRecipeRunId={workspaceRecipeRunId}
          workspaceRouteContext={workspaceRouteContext}
          artifactMirrorEpoch={artifactMirrorEpoch}
          onOpenVisual={onOpenVisual}
          onOpenDocument={onOpenDocument}
          onOpenCompare={() => {
            if (priorityPair) onOpenCompareArtifact(priorityPair.after, priorityRecipeRunId);
          }}
          onOpenDiff={onOpenDiff}
          onClear={onClearFocusedArtifact}
        />
      ) : null}
      {reviewWorkspaceArtifacts.length > 0 && (
        <View style={{ marginTop: spacing.lg }}>
          <EvidenceReviewWorkspace
            runId={run.id}
            gatewayUrl={gatewayUrl}
            artifacts={reviewWorkspaceArtifacts}
            pairs={reviewWorkspacePairs}
            authHeaders={authHeaders}
            onOpenVisual={onOpenVisual}
            onOpenDocument={onOpenDocument}
            onOpenDiff={onOpenDiff}
            onOpenArtifactWorkspace={onOpenArtifactWorkspace}
            onOpenCompareArtifactWorkspace={onOpenCompareArtifact}
          />
        </View>
      )}
      <ArtifactContextCard
        run={run}
        artifactCount={artifactCount}
        diffArtifactPath={diffArtifactPath}
        diffAvailable={diffAvailable}
        visualPairCount={priorityPairCount}
        scopeLabel={artifactScopeLabel(workspaceRecipeRunId, selectedRecipeRun)}
        focusedArtifactQuery={focusedArtifactQuery}
        focusedArtifactPath={focusedArtifactPath}
        workspaceRecipeRunId={workspaceRecipeRunId}
        workspaceRouteContext={workspaceRouteContext}
        onOpenCompare={() => {
          if (priorityPair) onOpenCompareArtifact(priorityPair.after, priorityRecipeRunId);
        }}
        onOpenDiff={onOpenDiff}
      />
      <ArtifactWorkspaceCockpit
        run={run}
        artifactCount={artifactCount}
        artifactCounts={artifactCounts}
        activeFilter={activeFilter}
        recipeRuns={recipeRuns}
        selectedRecipeRun={selectedRecipeRun}
        workspaceRecipeRunId={workspaceRecipeRunId}
        workspaceRouteContext={workspaceRouteContext}
        focusedArtifactPath={focusedArtifactPath}
        diffArtifactPath={diffArtifactPath}
        diffAvailable={diffAvailable}
        visualPairCount={pairs.length}
        fallbackVisualPairCount={recipeFallbackPairs.length}
        activeTaskProgress={activeTaskProgress}
        fallbackTaskProgress={fallbackTaskProgress}
        onOpenCompare={() => {
          if (priorityPair) onOpenCompareArtifact(priorityPair.after, priorityRecipeRunId);
        }}
        onFocusFilter={onFocusFilter}
        onSelectRecipeRun={onSelectRecipeRun}
        onOpenDiff={onOpenDiff}
      />
      {activeTaskProgress ? (
        <View style={styles.artifactProgressPanel}>
          <TaskProgressPanel
            run={run}
            progress={activeTaskProgress}
            error={taskProgressError}
            compact
          />
        </View>
      ) : fallbackTaskProgress ? (
        <View style={styles.artifactProgressPanel}>
          <TaskProgressFallbackPanel
            summary={fallbackTaskProgress}
            error={taskProgressError}
            compact
          />
        </View>
      ) : null}
      {recipeRuns.length > 0 && (
        <RecipeRunPicker
          groups={recipeRuns}
          selectedId={selectedRecipeRunId}
          onSelect={onSelectRecipeRun}
        />
      )}
      {/* Section title for individual artifacts */}
      {artifactCount > 0 && <Text style={styles.sectionTitle}>All Artifacts</Text>}
    </View>
  );
}
export function BeforeAfterPriorityPanel({
  pair,
  pairCount,
  authHeaders,
  artifactCount,
  recipeArtifactCount,
  recipeAvailable,
  diffValue,
  slotId,
  familyId,
  prNumber,
  eyebrow = 'Review first',
  title = 'Before → After evidence',
  copy = 'Validate what changed before approving the run.',
  onOpenArtifact,
  onShowVisuals,
  onOpenEvidence,
  onOpenRecipe,
  onOpenDiff,
  onOpenRun,
  onOpenFamily,
  onOpenTerminal,
  onOpenPR,
}: {
  pair: VisualArtifactPair;
  pairCount: number;
  authHeaders: ArtifactHttpHeaders;
  artifactCount: number;
  recipeArtifactCount: number;
  recipeAvailable?: boolean;
  diffValue: string;
  slotId?: string | null;
  familyId?: string | null;
  prNumber?: number | null;
  eyebrow?: string;
  title?: string;
  copy?: string;
  onOpenArtifact: (artifactPath: string) => void;
  onShowVisuals: () => void;
  onOpenEvidence: () => void;
  onOpenRecipe: () => void;
  onOpenDiff: () => void;
  onOpenRun: () => void;
  onOpenFamily: () => void;
  onOpenTerminal: () => void;
  onOpenPR: () => void;
}) {
  return (
    <View style={styles.beforeAfterPriorityPanel}>
      <BeforeAfterPreview
        pair={pair}
        authHeaders={authHeaders}
        onOpenArtifact={onOpenArtifact}
        eyebrow={eyebrow}
        title={title}
        hint={`${pairCount} pair${pairCount === 1 ? '' : 's'}`}
        imageHeight={92}
      />
      <View style={styles.beforeAfterPriorityActions}>
        <Text style={styles.beforeAfterPriorityCopy}>{copy}</Text>
        <Pressable style={styles.beforeAfterPriorityButton} onPress={onShowVisuals}>
          <Text style={styles.beforeAfterPriorityButtonText}>Show visual evidence</Text>
        </Pressable>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.beforeAfterPriorityRail}
      >
        <ArtifactFilterTile
          label="Evidence"
          value={String(artifactCount)}
          active={false}
          onPress={onOpenEvidence}
        />
        <ArtifactFilterTile
          label="Recipe"
          value={recipeAvailable ? String(recipeArtifactCount) : '-'}
          active={false}
          onPress={onOpenRecipe}
          disabled={recipeAvailable === false}
        />
        <ArtifactFilterTile label="Diff" value={diffValue} active={false} onPress={onOpenDiff} />
        <ArtifactFilterTile label="Run" value="detail" active={false} onPress={onOpenRun} />
        <ArtifactFilterTile
          label="Family"
          value={familyId ? shortId(familyId) : '-'}
          active={false}
          onPress={onOpenFamily}
          disabled={!familyId}
        />
        <ArtifactFilterTile
          label="Terminal"
          value={slotId ? 'live' : '-'}
          active={false}
          onPress={onOpenTerminal}
          disabled={!slotId}
        />
        <ArtifactFilterTile
          label="PR"
          value={prNumber ? `#${prNumber}` : '-'}
          active={false}
          onPress={onOpenPR}
          disabled={!prNumber}
        />
      </ScrollView>
    </View>
  );
}
export function FocusedArtifactPanel({
  run,
  artifact,
  diffArtifactPath,
  diffAvailable,
  comparePairCount,
  gatewayUrl,
  workspaceRecipeRunId,
  workspaceRouteContext,
  artifactMirrorEpoch,
  onOpenVisual,
  onOpenDocument,
  onOpenCompare,
  onOpenDiff,
  onClear,
}: {
  run: Run;
  artifact: ArtifactManifestEntry;
  diffArtifactPath: string | null;
  diffAvailable: boolean;
  comparePairCount: number;
  gatewayUrl: string;
  workspaceRecipeRunId: string | null;
  workspaceRouteContext: WorkspaceRouteContext;
  artifactMirrorEpoch: number;
  onOpenVisual: (uri: string) => void;
  onOpenDocument: (artifact: ArtifactManifestEntry) => void;
  onOpenCompare: () => void;
  onOpenDiff: (path?: string) => void;
  onClear: () => void;
}) {
  const router = useRouter();
  const mediaType = classifyArtifact(artifact);
  const isDiffArtifact = diffArtifactCandidate([artifact])?.path === artifact.path;
  const targetRouteContext = (
    targetWorkspace: Parameters<typeof targetWorkspaceRouteContextParams>[0],
  ) => targetWorkspaceRouteContextParams(targetWorkspace, workspaceRouteContext.decisionKind);
  const focusedContextParams = (
    targetWorkspace: Parameters<typeof targetWorkspaceRouteContextParams>[0],
  ) => ({
    ...targetRouteContext(targetWorkspace),
    ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
    artifact: artifact.path,
  });
  const openRecipeFiles = () => {
    const recipeTarget = recipeWorkspaceParam(workspaceRecipeRunId);
    router.push({
      pathname: '/artifacts/[runId]',
      params: {
        runId: run.id,
        ...targetRouteContext('recipe'),
        recipeRun: recipeTarget,
        filter: artifactFilterParamForWorkspaceNav('recipe'),
        ...(shouldPreserveArtifactForRecipeContext(recipeTarget, artifact.path)
          ? { artifact: artifact.path }
          : {}),
      },
    });
  };
  const openArtifact = () => {
    if (mediaType === 'image' || mediaType === 'video') {
      onOpenVisual(artifactUrlForEntry(gatewayUrl, run.id, artifact, artifactMirrorEpoch));
      return;
    }
    if (isDiffArtifact) {
      onOpenDiff(artifact.path);
      return;
    }
    if (mediaType === 'document') {
      onOpenDocument(artifact);
    }
  };
  const canOpen =
    mediaType === 'image' || mediaType === 'video' || mediaType === 'document' || isDiffArtifact;
  return (
    <View style={styles.focusedArtifactPanel}>
      <View style={styles.focusedArtifactHeader}>
        <View style={styles.focusedArtifactTitleBlock}>
          <Text style={styles.focusedArtifactEyebrow}>Focused artifact</Text>
          <Text style={styles.focusedArtifactPath} numberOfLines={2}>
            {artifact.path}
          </Text>
          {artifact.purpose || artifact.label ? (
            <Text style={styles.focusedArtifactMeta} numberOfLines={1}>
              {[artifact.label, artifact.purpose].filter(Boolean).join(' · ')}
            </Text>
          ) : null}
        </View>
        <View style={styles.focusedArtifactTypeBadge}>
          <Text style={styles.focusedArtifactTypeText}>
            {isDiffArtifact ? 'DIFF' : mediaType.toUpperCase()}
          </Text>
        </View>
      </View>
      <View style={styles.focusedArtifactActions}>
        <Pressable
          style={[styles.focusedArtifactAction, !canOpen && styles.focusedArtifactActionDisabled]}
          disabled={!canOpen}
          onPress={openArtifact}
        >
          <Text style={styles.focusedArtifactActionText}>
            {isDiffArtifact ? 'Open diff' : mediaType === 'document' ? 'Open document' : 'Preview'}
          </Text>
        </Pressable>
        {isDiffArtifact ? null : (
          <Pressable
            style={[
              styles.focusedArtifactAction,
              !diffAvailable && styles.focusedArtifactActionDisabled,
            ]}
            disabled={!diffAvailable}
            onPress={() => onOpenDiff(diffArtifactPath ?? undefined)}
          >
            <Text style={styles.focusedArtifactActionText}>Open diff</Text>
          </Pressable>
        )}
        <Pressable
          style={styles.focusedArtifactAction}
          onPress={() =>
            router.push({
              pathname: '/run/[id]',
              params: {
                id: run.id,
                ...focusedContextParams('run'),
              },
            })
          }
        >
          <Text style={styles.focusedArtifactActionText}>Run detail</Text>
        </Pressable>
        <Pressable style={styles.focusedArtifactAction} onPress={openRecipeFiles}>
          <Text style={styles.focusedArtifactActionText}>Recipe files</Text>
        </Pressable>
        <Pressable
          style={[
            styles.focusedArtifactAction,
            comparePairCount === 0 && styles.focusedArtifactActionDisabled,
          ]}
          disabled={comparePairCount === 0}
          onPress={onOpenCompare}
        >
          <Text style={styles.focusedArtifactActionText}>
            Before→After {comparePairCount > 0 ? `(${comparePairCount})` : ''}
          </Text>
        </Pressable>
        <Pressable
          style={[
            styles.focusedArtifactAction,
            !run.slotId && styles.focusedArtifactActionDisabled,
          ]}
          disabled={!run.slotId}
          onPress={() => {
            if (!run.slotId) return;
            router.push({
              pathname: '/slot/[id]',
              params: {
                id: run.slotId,
                runId: run.id,
                ...focusedContextParams('slot'),
              },
            });
          }}
        >
          <Text style={styles.focusedArtifactActionText}>Slot</Text>
        </Pressable>
        <Pressable
          style={[
            styles.focusedArtifactAction,
            !run.familyId && styles.focusedArtifactActionDisabled,
          ]}
          disabled={!run.familyId}
          onPress={() => {
            if (!run.familyId) return;
            router.push({
              pathname: '/family/[familyId]',
              params: {
                familyId: run.familyId,
                project: run.project,
                ...familySectionRouteContextParams('evidence', workspaceRouteContext.decisionKind),
                runId: run.id,
                section: 'evidence',
                ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
                artifact: artifact.path,
              },
            });
          }}
        >
          <Text style={styles.focusedArtifactActionText}>Family</Text>
        </Pressable>
        <Pressable
          style={[
            styles.focusedArtifactAction,
            !run.prNumber && styles.focusedArtifactActionDisabled,
          ]}
          disabled={!run.prNumber}
          onPress={() => {
            if (!run.prNumber) return;
            const prRepo = prRepoFromWorkspaceSource(run, run.prNumber);
            router.push({
              pathname: '/(tabs)/prs',
              params: {
                pr: String(run.prNumber),
                ...targetRouteContext('pr'),
                ...(prRepo ? { repo: prRepo } : {}),
              },
            });
          }}
        >
          <Text style={styles.focusedArtifactActionText}>PR</Text>
        </Pressable>
        <Pressable
          style={[
            styles.focusedArtifactAction,
            !run.slotId && styles.focusedArtifactActionDisabled,
          ]}
          disabled={!run.slotId}
          onPress={() => {
            if (!run.slotId) return;
            router.push({
              pathname: '/terminal/[slotId]',
              params: {
                slotId: run.slotId,
                runId: run.id,
                details: '1',
                ...focusedContextParams('terminal'),
              },
            });
          }}
        >
          <Text style={styles.focusedArtifactActionText}>Terminal</Text>
        </Pressable>
        <Pressable style={styles.focusedArtifactClear} onPress={onClear}>
          <Text style={styles.focusedArtifactClearText}>Clear</Text>
        </Pressable>
      </View>
    </View>
  );
}
export function ArtifactContextCard({
  run,
  artifactCount,
  diffArtifactPath,
  diffAvailable,
  visualPairCount,
  scopeLabel,
  focusedArtifactQuery,
  focusedArtifactPath,
  workspaceRecipeRunId,
  workspaceRouteContext,
  onOpenCompare,
  onOpenDiff,
}: {
  run: Run;
  artifactCount: number;
  diffArtifactPath: string | null;
  diffAvailable: boolean;
  visualPairCount: number;
  scopeLabel: string;
  focusedArtifactQuery: string;
  focusedArtifactPath: string | null;
  workspaceRecipeRunId: string | null;
  workspaceRouteContext: WorkspaceRouteContext;
  onOpenCompare: () => void;
  onOpenDiff: (path?: string) => void;
}) {
  const router = useRouter();
  const statusColor = runStatusColor(run.status);
  const readyDecision = selectReadyWorkspaceDecision(run);
  const reviewGateDecision = selectReviewGateWorkspaceDecision(run);
  const retroDecision = selectRetrospectiveWorkspaceDecision(run);
  const targetRouteContext = (
    targetWorkspace: Parameters<typeof targetWorkspaceRouteContextParams>[0],
  ) => targetWorkspaceRouteContextParams(targetWorkspace, workspaceRouteContext.decisionKind);
  const openDecision = (decisionId: string | null | undefined, targetDecisionKind?: string) => {
    if (!decisionId) return;
    router.push({
      pathname: '/decision/[id]',
      params: {
        id: decisionId,
        ...workspaceRouteContext,
        ...decisionWorkspaceRouteParams(targetDecisionKind),
        runId: run.id,
        ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
        ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
      },
    });
  };
  return (
    <View style={styles.contextCard}>
      <View style={styles.contextHeader}>
        <Text style={styles.contextEyebrow}>Artifact workspace</Text>
        <View style={[styles.contextStatusBadge, { backgroundColor: statusColor + '22' }]}>
          <Text style={[styles.contextStatusText, { color: statusColor }]}>{run.status}</Text>
        </View>
      </View>
      <View style={styles.contextGrid}>
        <ArtifactContextMetric
          label="Slot"
          value={run.slotId ?? '-'}
          disabled={!run.slotId}
          onPress={() => {
            if (!run.slotId) return;
            router.push({
              pathname: '/slot/[id]',
              params: {
                id: run.slotId,
                ...targetRouteContext('slot'),
                runId: run.id,
                ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
                ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
              },
            });
          }}
        />
        <ArtifactContextMetric
          label="Family"
          value={shortId(run.familyId)}
          disabled={!run.familyId}
          onPress={() => {
            if (!run.familyId) return;
            router.push({
              pathname: '/family/[familyId]',
              params: {
                familyId: run.familyId,
                project: run.project,
                ...familySectionRouteContextParams('evidence', workspaceRouteContext.decisionKind),
                runId: run.id,
                section: 'evidence',
                ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
                ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
              },
            });
          }}
        />
        <ArtifactContextMetric label="Scope" value={scopeLabel} />
        <ArtifactContextMetric
          label="Ready gate"
          value={readyDecision ? (readyDecision.resolvedAt ? 'resolved' : 'pending') : '-'}
          disabled={!readyDecision}
          onPress={() => openDecision(readyDecision?.id, 'ready')}
        />
        <ArtifactContextMetric
          label="Review gate"
          value={reviewGateDecision ? workspaceDecisionKind(reviewGateDecision) || 'review' : '-'}
          disabled={!reviewGateDecision}
          onPress={() =>
            openDecision(reviewGateDecision?.id, workspaceDecisionKind(reviewGateDecision))
          }
        />
        <ArtifactContextMetric
          label="Retro gate"
          value={retroDecision ? (retroDecision.resolvedAt ? 'recorded' : 'pending') : '-'}
          disabled={!retroDecision}
          onPress={() => openDecision(retroDecision?.id, 'retrospective')}
        />
        <ArtifactContextMetric
          label="Family retros"
          value={run.familyId ? 'open' : '-'}
          disabled={!run.familyId}
          onPress={() => {
            if (!run.familyId) return;
            router.push({
              pathname: '/family/[familyId]',
              params: {
                familyId: run.familyId,
                project: run.project,
                ...familySectionRouteContextParams('retros', workspaceRouteContext.decisionKind),
                runId: run.id,
                section: 'retros',
                ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
                ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
              },
            });
          }}
        />
        <ArtifactContextMetric
          label="Diff view"
          value={diffArtifactPath ?? (run.slotId && diffAvailable ? 'live workspace' : 'missing')}
          disabled={!diffAvailable}
          onPress={() => onOpenDiff(diffArtifactPath ?? undefined)}
        />
        <ArtifactContextMetric
          label="Before→After"
          value={String(visualPairCount)}
          disabled={visualPairCount === 0}
          onPress={onOpenCompare}
        />
        <ArtifactContextMetric
          label="Focus"
          value={focusedArtifactQuery ? focusedArtifactQuery : `${artifactCount} artifacts`}
        />
      </View>
    </View>
  );
}
export function ArtifactContextMetric({
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
      <Text style={styles.contextMetricLabel}>{label}</Text>
      <Text style={styles.contextMetricValue} numberOfLines={1}>
        {value}
        {onPress && !disabled ? ' ›' : ''}
      </Text>
    </>
  );
  if (onPress) {
    return (
      <Pressable
        style={[styles.contextMetric, disabled && styles.contextMetricDisabled]}
        onPress={onPress}
        disabled={disabled}
      >
        {content}
      </Pressable>
    );
  }
  return <View style={styles.contextMetric}>{content}</View>;
}
export function ArtifactWorkspaceCockpit({
  run,
  artifactCount,
  artifactCounts,
  activeFilter,
  recipeRuns,
  selectedRecipeRun,
  workspaceRecipeRunId,
  workspaceRouteContext,
  focusedArtifactPath,
  diffArtifactPath,
  diffAvailable,
  visualPairCount,
  fallbackVisualPairCount,
  activeTaskProgress,
  fallbackTaskProgress,
  onOpenCompare,
  onFocusFilter,
  onSelectRecipeRun,
  onOpenDiff,
}: {
  run: Run;
  artifactCount: number;
  artifactCounts: ArtifactWorkspaceCounts;
  activeFilter: ArtifactWorkspaceFilter;
  recipeRuns: RecipeRunArtifactGroup[];
  selectedRecipeRun: RecipeRunArtifactGroup | null;
  workspaceRecipeRunId: string | null;
  workspaceRouteContext: WorkspaceRouteContext;
  focusedArtifactPath: string | null;
  diffArtifactPath: string | null;
  diffAvailable: boolean;
  visualPairCount: number;
  fallbackVisualPairCount: number;
  activeTaskProgress: TaskProgressStructured | null;
  fallbackTaskProgress: ReturnType<typeof fallbackTaskProgressSummary> | null;
  onOpenCompare: () => void;
  onFocusFilter: (filter: ArtifactWorkspaceFilter) => void;
  onSelectRecipeRun: (id: string | null) => void;
  onOpenDiff: (path?: string) => void;
}) {
  const router = useRouter();
  const recipeScoped = Boolean(selectedRecipeRun);
  const recipeScopeTarget = selectedRecipeRun?.id ?? recipeRuns[0]?.id ?? null;
  const recipeScopeLabel = recipeWorkspaceScopeLabel(workspaceRecipeRunId);
  const terminalAvailable = Boolean(run.slotId);
  const comparePairCount = visualPairCount > 0 ? visualPairCount : fallbackVisualPairCount;
  const compareLabel = visualPairCount > 0 ? 'Before→After' : 'Recipe compare';
  const progressValue = activeTaskProgress
    ? `${Math.round(taskProgressPercent(activeTaskProgress))}%`
    : fallbackTaskProgress?.percent != null
      ? `${Math.round(fallbackTaskProgress.percent)}%`
      : fallbackTaskProgress
        ? 'live'
        : '-';
  const readyDecision = selectReadyWorkspaceDecision(run);
  const reviewGateDecision = selectReviewGateWorkspaceDecision(run);
  const retroDecision = selectRetrospectiveWorkspaceDecision(run);
  const targetRouteContext = (
    targetWorkspace: Parameters<typeof targetWorkspaceRouteContextParams>[0],
  ) => targetWorkspaceRouteContextParams(targetWorkspace, workspaceRouteContext.decisionKind);
  const openDecision = (decisionId: string | null | undefined, targetDecisionKind?: string) => {
    if (!decisionId) return;
    router.push({
      pathname: '/decision/[id]',
      params: {
        id: decisionId,
        ...workspaceRouteContext,
        ...decisionWorkspaceRouteParams(targetDecisionKind),
        runId: run.id,
        ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
        ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
      },
    });
  };
  const openDiff = () => {
    if (diffArtifactPath) {
      onOpenDiff(diffArtifactPath);
      return;
    }
    onOpenDiff();
  };
  return (
    <View style={styles.artifactCockpitPanel}>
      <View style={styles.artifactCockpitHeader}>
        <View style={styles.artifactCockpitTitleBlock}>
          <Text style={styles.artifactCockpitTitle}>Artifact cockpit</Text>
          <Text style={styles.artifactCockpitMeta} numberOfLines={1}>
            {recipeScoped ? selectedRecipeRun?.label : 'Decision evidence'} · {artifactCount} files
          </Text>
        </View>
        <Pressable
          style={[styles.artifactCockpitPill, !terminalAvailable && styles.artifactCockpitDisabled]}
          disabled={!terminalAvailable}
          onPress={() => {
            if (!run.slotId) return;
            router.push({
              pathname: '/terminal/[slotId]',
              params: {
                slotId: run.slotId,
                ...targetRouteContext('terminal'),
                runId: run.id,
                details: '1',
                ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
                ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
              },
            });
          }}
        >
          <Text style={styles.artifactCockpitPillText}>Terminal</Text>
        </Pressable>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.artifactCockpitRail}
      >
        <ArtifactFilterTile
          label="All"
          value={String(artifactCounts.all)}
          active={activeFilter === 'all'}
          onPress={() => onFocusFilter('all')}
        />
        <ArtifactFilterTile
          label={compareLabel}
          value={`${comparePairCount} pair${comparePairCount === 1 ? '' : 's'}`}
          active={activeFilter === 'visual'}
          onPress={onOpenCompare}
          disabled={comparePairCount === 0}
        />
        <ArtifactFilterTile
          label="Run"
          value={shortId(run.id)}
          active={false}
          onPress={() =>
            router.push({
              pathname: '/run/[id]',
              params: {
                id: run.id,
                ...targetRouteContext('run'),
                ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
                ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
              },
            })
          }
        />
        <ArtifactFilterTile
          label="Slot"
          value={run.slotId ?? '-'}
          active={false}
          disabled={!run.slotId}
          onPress={() => {
            if (!run.slotId) return;
            router.push({
              pathname: '/slot/[id]',
              params: {
                id: run.slotId,
                ...targetRouteContext('slot'),
                runId: run.id,
                ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
                ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
              },
            });
          }}
        />
        <ArtifactFilterTile
          label="PR"
          value={run.prNumber ? `#${run.prNumber}` : '-'}
          active={false}
          disabled={!run.prNumber}
          onPress={() => {
            if (!run.prNumber) return;
            const prRepo = prRepoFromWorkspaceSource(run, run.prNumber);
            router.push({
              pathname: '/(tabs)/prs',
              params: {
                pr: String(run.prNumber),
                ...targetRouteContext('pr'),
                ...(prRepo ? { repo: prRepo } : {}),
              },
            });
          }}
        />
        <ArtifactFilterTile
          label="Ready gate"
          value={readyDecision ? (readyDecision.resolvedAt ? 'resolved' : 'pending') : '-'}
          active={false}
          disabled={!readyDecision}
          onPress={() => openDecision(readyDecision?.id, 'ready')}
        />
        <ArtifactFilterTile
          label="Review gate"
          value={
            reviewGateDecision ? (reviewGateDecision.resolvedAt ? 'resolved' : 'pending') : '-'
          }
          active={false}
          disabled={!reviewGateDecision}
          onPress={() =>
            openDecision(reviewGateDecision?.id, workspaceDecisionKind(reviewGateDecision))
          }
        />
        <ArtifactFilterTile
          label="Retro gate"
          value={retroDecision ? (retroDecision.resolvedAt ? 'recorded' : 'pending') : '-'}
          active={false}
          disabled={!retroDecision}
          onPress={() => openDecision(retroDecision?.id, 'retrospective')}
        />
        <ArtifactFilterTile
          label="Family retros"
          value={run.familyId ? 'open' : '-'}
          active={false}
          disabled={!run.familyId}
          onPress={() => {
            if (!run.familyId) return;
            router.push({
              pathname: '/family/[familyId]',
              params: {
                familyId: run.familyId,
                project: run.project,
                ...familySectionRouteContextParams('retros', workspaceRouteContext.decisionKind),
                runId: run.id,
                section: 'retros',
                ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
                ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
              },
            });
          }}
        />
        <ArtifactFilterTile
          label="Progress"
          value={progressValue}
          active={false}
          disabled={!activeTaskProgress && !fallbackTaskProgress}
          onPress={() => {
            if (!run.slotId) return;
            router.push({
              pathname: '/terminal/[slotId]',
              params: {
                slotId: run.slotId,
                ...targetRouteContext('terminal'),
                runId: run.id,
                details: '1',
                ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
                ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
              },
            });
          }}
        />
        <ArtifactFilterTile
          label="Visual files"
          value={String(artifactCounts.visual)}
          active={activeFilter === 'visual' && visualPairCount === 0}
          onPress={() => onFocusFilter('visual')}
          disabled={artifactCounts.visual === 0}
        />
        <ArtifactFilterTile
          label="Doc files"
          value={String(artifactCounts.docs)}
          active={activeFilter === 'docs'}
          onPress={() => onFocusFilter('docs')}
          disabled={artifactCounts.docs === 0}
        />
        <ArtifactFilterTile
          label="Diff files"
          value={String(artifactCounts.diffs)}
          active={activeFilter === 'diffs'}
          onPress={() => onFocusFilter('diffs')}
          disabled={artifactCounts.diffs === 0}
        />
        <ArtifactFilterTile
          label="Recipe files"
          value={String(artifactCounts.recipes)}
          hint={`${recipeScopeLabel} recipe scope`}
          active={activeFilter === 'recipes'}
          onPress={() => onFocusFilter('recipes')}
          disabled={recipeScoped || artifactCounts.recipes === 0}
        />
        <ArtifactFilterTile
          label="Review files"
          value={String(artifactCounts.review)}
          active={activeFilter === 'review'}
          onPress={() => onFocusFilter('review')}
          disabled={artifactCounts.review === 0}
        />
        <ArtifactFilterTile
          label="Open diff"
          value={diffArtifactPath ? 'artifact' : run.slotId ? 'workspace' : 'missing'}
          active={false}
          onPress={openDiff}
          disabled={!diffAvailable}
        />
        <ArtifactFilterTile
          label="Recipe scope"
          value={recipeScoped ? recipeScopeLabel : 'select'}
          hint={recipeScoped ? selectedRecipeRun?.label : undefined}
          active={recipeScoped}
          disabled={!recipeScopeTarget}
          onPress={() => onSelectRecipeRun(recipeScopeTarget)}
        />
        <ArtifactFilterTile
          label="Run files"
          value={String(artifactCount)}
          active={!recipeScoped}
          onPress={() => onSelectRecipeRun(null)}
        />
        <ArtifactFilterTile
          label="Family"
          value={shortId(run.familyId)}
          active={false}
          disabled={!run.familyId}
          onPress={() =>
            router.push({
              pathname: '/family/[familyId]',
              params: {
                familyId: run.familyId!,
                project: run.project,
                ...familySectionRouteContextParams('evidence', workspaceRouteContext.decisionKind),
                runId: run.id,
                section: 'evidence',
                ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
                ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
              },
            })
          }
        />
      </ScrollView>
    </View>
  );
}
export function ArtifactFilterTile({
  label,
  value,
  hint,
  active,
  disabled,
  onPress,
}: {
  label: string;
  value: string;
  hint?: string;
  active: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={[
        styles.artifactCockpitTile,
        active && styles.artifactCockpitTileActive,
        disabled && styles.artifactCockpitDisabled,
      ]}
      disabled={disabled}
      onPress={onPress}
    >
      <Text
        style={[styles.artifactCockpitTileLabel, active && styles.artifactCockpitTileLabelActive]}
      >
        {label}
      </Text>
      <Text style={styles.artifactCockpitTileValue} numberOfLines={1}>
        {value}
      </Text>
      {hint ? (
        <Text style={styles.artifactCockpitTileHint} numberOfLines={1}>
          {hint}
        </Text>
      ) : null}
    </Pressable>
  );
}
export function artifactScopeLabel(
  workspaceRecipeRunId: string | null,
  selectedRecipeRun: RecipeRunArtifactGroup | null,
): string {
  if (selectedRecipeRun) return selectedRecipeRun.label;
  if (workspaceRecipeRunId === DECISION_EVIDENCE_RECIPE_RUN_PARAM) return 'decision evidence';
  if (workspaceRecipeRunId) return workspaceRecipeRunId;
  return 'run evidence';
}
export function shortId(value: string | null | undefined): string {
  if (!value) return '-';
  return value.length <= 10 ? value : `${value.slice(0, 8)}…`;
}
export function groupArtifacts(
  manifest: ArtifactManifestEntry[],
  gatewayUrl: string,
  runId: string,
  artifactMirrorEpoch: number,
): {
  pairs: VisualArtifactPair[];
  singles: ArtifactManifestEntry[];
} {
  const pairs: VisualArtifactPair[] = [];
  const grouped = groupVisualArtifactPairs(manifest, (artifact) =>
    artifactUrlForEntry(gatewayUrl, runId, artifact, artifactMirrorEpoch),
  );
  pairs.push(...grouped.pairs);
  return { pairs, singles: grouped.singles };
}
export function runStatusColor(status: Run['status']): string {
  if (status === 'done') return colors.statusOk;
  if (status === 'failed') return colors.statusFail;
  if (status === 'cancelled') return colors.statusWarn;
  if (status === 'paused') return colors.statusWarn;
  return colors.accent;
}
export function RecipeRunPicker({
  groups,
  selectedId,
  onSelect,
}: {
  groups: RecipeRunArtifactGroup[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  return (
    <View style={styles.recipePicker}>
      <View style={styles.recipePickerHeader}>
        <Text style={styles.recipePickerTitle}>Recipe runs</Text>
        <Text style={styles.recipePickerHint}>Tap a run to scope artifacts</Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Pressable
          style={[styles.recipeChip, selectedId === null && styles.recipeChipActive]}
          onPress={() => onSelect(null)}
        >
          <Text style={[styles.recipeChipText, selectedId === null && styles.recipeChipTextActive]}>
            Decision evidence
          </Text>
        </Pressable>
        {groups.map((group) => (
          <Pressable
            key={group.id}
            style={[styles.recipeChip, selectedId === group.id && styles.recipeChipActive]}
            onPress={() => onSelect(group.id)}
          >
            <Text
              style={[
                styles.recipeChipText,
                selectedId === group.id && styles.recipeChipTextActive,
              ]}
              numberOfLines={1}
            >
              {group.label}
            </Text>
            <Text style={styles.recipeChipMeta}>
              {group.status} · {group.artifactManifest?.length ?? 0}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}
