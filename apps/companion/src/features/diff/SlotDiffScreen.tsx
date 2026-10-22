import { useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  extractRunArtifactManifest,
  type GitDiffResult,
  Methods,
  type RunForSlotResult,
  type RunGetResult,
  type RunRecipeRunsForRunResult,
} from '@farmslot/protocol';
import { type ResourceQuery, resourceQuery } from '@farmslot/protocol/client-cache';

import { BeforeAfterPreview } from '../../components/BeforeAfterPreview';
import { MobileDiffViewer } from '../../components/MobileDiffViewer';
import { ResourceReadStatus } from '../../components/ResourceReadStatus';
import { RunWorkspaceNav } from '../../components/RunWorkspaceNav';
import { observeNativeSlotFrame } from '../../farmslot/run-collections-proof';
import { useResourceQuery } from '../../hooks/useResourceQuery';
import {
  type ArtifactManifestEntry,
  artifactsForRecipeRun,
  artifactUrlForEntry,
  CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
  DECISION_EVIDENCE_RECIPE_RUN_PARAM,
  groupVisualArtifactPairs,
} from '../../lib/artifact-url';
import { prRepoFromWorkspaceSource } from '../../lib/pr-links';
import { getResourceCache, getResourceWorkspaceKey } from '../../lib/resource-cache';
import {
  selectSlotCompareTarget,
  selectSlotRecipeArtifactsForPreviewScope,
} from '../../lib/slot-workspace';
import { baseStyles } from '../../lib/theme';
import {
  selectPrimaryWorkspaceDecision,
  selectReadyWorkspaceDecision,
  selectRetrospectiveWorkspaceDecision,
  selectReviewGateWorkspaceDecision,
  workspaceDecisionKind,
} from '../../lib/workspace-decisions';
import { summarizeRunWorkspaceNavMeta } from '../../lib/workspace-nav-meta';
import {
  artifactFilterParamForWorkspaceNav,
  targetWorkspaceRouteContextParams,
  workspaceRouteContextParams,
} from '../../lib/workspace-navigation';
import { useConnectionStore } from '../../store/connection';
import { useFleetStore } from '../../store/fleet';
import { useSlotWorkspaceTabs } from '../workspace-shared/slot-workspace-tabs';

import { routeParamString, SlotDiffCockpit } from './components/slot-diff-panels';
import { slotDiffStyles as styles } from './styles/slot-diff.styles';

interface SlotDiffRead {
  key: string;
  diff: string;
  loading: boolean;
  error?: string;
}

export default function SlotDiffViewerScreen() {
  const { slotId, path, workspace, decisionKind } = useLocalSearchParams<{
    slotId: string;
    path?: string | string[];
    workspace?: string | string[];
    decisionKind?: string | string[];
  }>();
  const router = useRouter();
  const focused = useIsFocused();
  const insideSlotWorkspaceTabs = useSlotWorkspaceTabs();
  const client = useConnectionStore((s) => s.client);
  const gatewayUrl = useConnectionStore((s) => s.gatewayUrl);
  const artifactAuthHeaders = useConnectionStore((s) => s.activeProfileHttpAuthHeaders);
  const slot = useFleetStore((s) => s.fleet?.slots.find((entry) => entry.slot === slotId));
  const slotRunQuery = useMemo(
    () => (slotId ? resourceQuery<RunForSlotResult>(Methods.RUN_FOR_SLOT, { slotId }) : undefined),
    [slotId],
  );
  const slotRunObservation = useResourceQuery(slotRunQuery);
  const currentRunId = slotRunObservation.data
    ? (slotRunObservation.data.run?.id ?? null)
    : (slot?.currentRunId ?? null);
  const runQuery = useMemo(
    () =>
      currentRunId
        ? resourceQuery<RunGetResult>(Methods.RUN_GET, { runId: currentRunId })
        : undefined,
    [currentRunId],
  );
  const runObservation = useResourceQuery(runQuery);
  const currentRun = runObservation.data?.run ?? null;
  const recipeQuery = useMemo(
    () =>
      currentRunId
        ? resourceQuery<RunRecipeRunsForRunResult>(Methods.RUN_RECIPE_RUNS_FOR_RUN, {
            runId: currentRunId,
          })
        : undefined,
    [currentRunId],
  );
  const recipeObservation = useResourceQuery(recipeQuery);
  const recipeRuns = recipeObservation.data?.recipeRuns ?? [];
  const recipeRunsLoaded = Boolean(recipeObservation.data);
  const workspaceKey = getResourceWorkspaceKey();
  const [diffRead, setDiffRead] = useState<SlotDiffRead>();
  const diffScope = JSON.stringify([workspaceKey, slotId, currentRunId]);
  const currentDiff = diffRead?.key === diffScope ? diffRead : undefined;
  const diffText = currentDiff?.diff ?? '';
  const loading = currentDiff?.loading ?? false;
  const error = currentDiff?.error ?? null;
  const readError =
    slotRunObservation.error?.message ??
    runObservation.error?.message ??
    recipeObservation.error?.message;
  const retryRead = async () => {
    const cache = getResourceCache();
    const queries: Array<ResourceQuery<unknown> | undefined> = [
      slotRunQuery,
      runQuery,
      recipeQuery,
    ];
    await Promise.all(
      queries
        .filter((query) => query && cache?.read(query).error)
        .map((query) => cache?.retry(query!)),
    );
  };
  const frame = useRef({ focused, run: currentRun, recipes: recipeObservation });
  frame.current = { focused, run: currentRun, recipes: recipeObservation };
  useEffect(() => {
    if (__DEV__ && currentRunId)
      return observeNativeSlotFrame('slot-diff', currentRunId, () => frame.current);
  }, [currentRunId]);
  const diffRefreshRequestRef = useRef(0);

  const pathParamError = Array.isArray(path) ? 'Only one diff path can be opened at a time.' : null;
  const requestedPath = !pathParamError && typeof path === 'string' ? path.trim() : '';
  const workspaceRouteContext = useMemo(
    () =>
      workspaceRouteContextParams(
        routeParamString(workspace),
        routeParamString(decisionKind),
        'diff',
      ),
    [decisionKind, workspace],
  );
  const slotRouteContext = useMemo(
    () => targetWorkspaceRouteContextParams('slot', workspaceRouteContext.decisionKind),
    [workspaceRouteContext.decisionKind],
  );
  const compareRouteContext = useMemo(
    () => targetWorkspaceRouteContextParams('compare', workspaceRouteContext.decisionKind),
    [workspaceRouteContext.decisionKind],
  );

  const refreshDiff = useCallback(
    async (reason: string, reset: boolean) => {
      const requestId = diffRefreshRequestRef.current + 1;
      diffRefreshRequestRef.current = requestId;
      if (
        !client ||
        client.connectionState !== 'connected' ||
        !slotId ||
        pathParamError ||
        (currentRunId && runObservation.status !== 'ready') ||
        slotRunObservation.status !== 'ready'
      ) {
        setDiffRead((previous) =>
          previous?.key === diffScope ? { ...previous, loading: false } : undefined,
        );
        return;
      }

      setDiffRead((previous) => ({
        key: diffScope,
        diff: previous?.key === diffScope ? previous.diff : '',
        loading: reset,
      }));
      const generation = client.connectionGeneration;
      const current = () =>
        diffRefreshRequestRef.current === requestId &&
        workspaceKey === getResourceWorkspaceKey() &&
        generation === client.connectionGeneration;
      try {
        const result = await client.request<GitDiffResult>(Methods.GIT_DIFF, { slotId });
        if (!current()) return;
        setDiffRead({ key: diffScope, diff: result.diff, loading: false });
      } catch (err) {
        if (!current()) return;
        setDiffRead({
          key: diffScope,
          diff: '',
          loading: false,
          error: `Failed to refresh live workspace diff after ${reason}: ${(err as Error).message}`,
        });
      } finally {
        if (diffRefreshRequestRef.current === requestId)
          setDiffRead((previous) =>
            previous?.key === diffScope ? { ...previous, loading: false } : previous,
          );
      }
    },
    [
      client,
      currentRunId,
      pathParamError,
      slotId,
      runObservation.status,
      slotRunObservation.status,
      diffScope,
      workspaceKey,
    ],
  );

  useEffect(() => {
    void refreshDiff('initial load', true);
    return () => {
      diffRefreshRequestRef.current++;
    };
  }, [refreshDiff, requestedPath]);

  const goBackOrSlot = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace({
      pathname: '/workspace/slot/[slotId]/slot',
      params: { slotId, ...slotRouteContext },
    });
  }, [router, slotId, slotRouteContext]);

  const primaryDecision = selectPrimaryWorkspaceDecision(currentRun);
  const readyDecision = selectReadyWorkspaceDecision(currentRun);
  const reviewGateDecision = selectReviewGateWorkspaceDecision(currentRun);
  const retroDecision = selectRetrospectiveWorkspaceDecision(currentRun);
  const workspaceNavMeta = summarizeRunWorkspaceNavMeta(currentRun);
  const navRunId = currentRun?.id ?? currentRunId;
  const recipeArtifactCount = recipeRunsLoaded
    ? recipeRuns.reduce((count, group) => count + artifactsForRecipeRun(group).length, 0)
    : null;
  const recipeAvailable = recipeArtifactCount === null ? undefined : recipeArtifactCount > 0;
  const diffAvailable = loading ? undefined : diffText.length > 0;
  const runArtifacts: ArtifactManifestEntry[] = currentRun
    ? extractRunArtifactManifest(currentRun)
    : [];
  const navVisualPairs = navRunId
    ? groupVisualArtifactPairs(runArtifacts, (artifact) =>
        artifactUrlForEntry(gatewayUrl, navRunId, artifact),
      ).pairs
    : [];
  const recipeVisualPairs =
    navRunId && navVisualPairs.length === 0
      ? groupVisualArtifactPairs(
          selectSlotRecipeArtifactsForPreviewScope(recipeRuns, null),
          (artifact) => artifactUrlForEntry(gatewayUrl, navRunId, artifact),
        ).pairs
      : [];
  const priorityVisualPairs = navVisualPairs.length > 0 ? navVisualPairs : recipeVisualPairs;
  const priorityVisualPair = priorityVisualPairs[0] ?? null;
  const priorityCompareRecipeRunId =
    navVisualPairs.length > 0
      ? DECISION_EVIDENCE_RECIPE_RUN_PARAM
      : (priorityVisualPair?.after.recipeRunId ?? CURRENT_ARTIFACTS_RECIPE_RUN_PARAM);
  const compareTarget = currentRun
    ? selectSlotCompareTarget({ runArtifacts, recipeRuns, selectedRecipeRunId: null })
    : null;
  const navVisualPairCount =
    priorityVisualPairs.length > 0 ? priorityVisualPairs.length : (compareTarget?.pairCount ?? 0);
  const navCompareArtifactPath =
    priorityVisualPair?.after.path ?? compareTarget?.artifactPath ?? null;
  const navCompareRecipeRunId = priorityVisualPair
    ? priorityCompareRecipeRunId
    : navVisualPairs.length > 0
      ? DECISION_EVIDENCE_RECIPE_RUN_PARAM
      : compareTarget?.recipeRunId;
  return (
    <SafeAreaView
      edges={insideSlotWorkspaceTabs ? ['bottom'] : ['top', 'bottom']}
      style={baseStyles.container}
    >
      {!insideSlotWorkspaceTabs ? (
        <View style={styles.header}>
          <Pressable style={styles.backButton} onPress={goBackOrSlot}>
            <Text style={styles.backButtonText}>‹ Back</Text>
          </Pressable>
          <View style={styles.headerTitle}>
            <Text style={styles.eyebrow}>Slot diff</Text>
            <Text style={styles.title} numberOfLines={2}>
              {requestedPath || slotId}
            </Text>
            {currentRun ? (
              <Text style={styles.subtitle} numberOfLines={1}>
                {currentRun.ticketOrPr} · {currentRun.status}
              </Text>
            ) : null}
          </View>
        </View>
      ) : null}
      <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
        <ResourceReadStatus observation={runObservation} label="slot diff run" />
        <ResourceReadStatus observation={recipeObservation} label="slot diff recipe inventory" />
        {readError ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry slot diff reads"
            onPress={() => void retryRead()}
          >
            <Text style={baseStyles.textSecondary}>Retry</Text>
          </Pressable>
        ) : null}
        <RunWorkspaceNav
          current="diff"
          dense
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
          familyId={currentRun?.familyId}
          project={currentRun?.project}
          prNumber={currentRun?.prNumber}
          prRepo={prRepoFromWorkspaceSource(currentRun, currentRun?.prNumber ?? null)}
          recipeRunId={navRunId ? DECISION_EVIDENCE_RECIPE_RUN_PARAM : null}
          runId={navRunId}
          slotId={slotId}
          artifactPath={requestedPath}
          recipeAvailable={recipeAvailable}
          recipeArtifactCount={recipeArtifactCount}
          diffAvailable={diffAvailable}
          artifactCount={runArtifacts.length}
          visualPairCount={navVisualPairCount}
          compareArtifactPath={navCompareArtifactPath}
          compareRecipeRunId={navCompareRecipeRunId}
        />
        <SlotDiffCockpit
          slotId={slotId}
          run={currentRun}
          currentRunId={currentRunId}
          requestedPath={requestedPath}
          recipeArtifactCount={recipeArtifactCount}
          recipeAvailable={recipeAvailable}
          comparePairCount={navVisualPairCount}
          compareArtifactPath={navCompareArtifactPath}
          compareRecipeRunId={navCompareRecipeRunId}
          compareUsesRecipe={navVisualPairs.length === 0 && Boolean(compareTarget)}
          workspaceRouteContext={workspaceRouteContext}
        />
        {priorityVisualPair && navRunId ? (
          <View style={styles.comparePreviewPanel}>
            <BeforeAfterPreview
              pair={priorityVisualPair}
              authHeaders={artifactAuthHeaders}
              onOpenArtifact={(artifactPath) =>
                router.push({
                  pathname: '/workspace/run/[runId]/files',
                  params: {
                    runId: navRunId,
                    ...compareRouteContext,
                    recipeRun: priorityCompareRecipeRunId,
                    filter: artifactFilterParamForWorkspaceNav('compare'),
                    artifact: artifactPath,
                  },
                })
              }
              eyebrow={navVisualPairs.length > 0 ? 'Live run evidence' : 'Recipe evidence'}
              title="Before → after context"
              hint={`${priorityVisualPairs.length} pair${priorityVisualPairs.length === 1 ? '' : 's'}`}
              imageHeight={64}
            />
          </View>
        ) : null}
        {pathParamError || error ? (
          <Text style={styles.errorText}>{pathParamError ?? error}</Text>
        ) : null}
        {diffText ? (
          <MobileDiffViewer
            title={requestedPath ? `${requestedPath} · workspace` : 'Workspace diff'}
            diffText={diffText}
            initialPath={requestedPath}
          />
        ) : loading ? (
          <Text style={styles.emptyText}>Loading live workspace diff…</Text>
        ) : (
          <Text style={styles.emptyText}>No live workspace diff found for this slot.</Text>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
