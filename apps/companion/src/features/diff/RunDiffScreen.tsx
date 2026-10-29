import { useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  extractRunArtifactManifest,
  type RecipeRunArtifactGroup,
  type RunGetResult,
  type RunRecipeRunsForRunResult,
} from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import { MobileDiffViewer } from '../../components/MobileDiffViewer';
import { ResourceReadStatus } from '../../components/ResourceReadStatus';
import { RunWorkspaceNav } from '../../components/RunWorkspaceNav';
import { observeD12RunDiff, type RunDiffFrame } from '../../farmslot/d12-native-proof';
import { observeNativeDiffFrame } from '../../farmslot/run-collections-proof';
import { useActiveRunDiffQuery, useGateDiffContent } from '../../hooks/useHeldContent';
import { useResourceQuery } from '../../hooks/useResourceQuery';
import {
  type ArtifactManifestEntry,
  artifactsForRecipeRun,
  artifactUrlForEntry,
  CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
  DECISION_EVIDENCE_RECIPE_RUN_PARAM,
  groupVisualArtifactPairs,
  resolveRecipeRunSelection,
} from '../../lib/artifact-url';
import { diffArtifactCandidate, diffFocusedFilePathFromRequest } from '../../lib/diff';
import { gateDiffFallsBack } from '../../lib/held-content';
import { prRepoFromWorkspaceSource } from '../../lib/pr-links';
import { getResourceCache } from '../../lib/resource-cache';
import { selectSlotRecipeArtifactsForPreviewScope } from '../../lib/slot-workspace';
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
  shouldPreserveArtifactForDiffContext,
  workspaceRouteContextParams,
} from '../../lib/workspace-navigation';
import { useConnectionStore } from '../../store/connection';
import { useReviewPackageTab } from '../workspace-shared/review-package-tabs';

import {
  DiffWorkspaceCockpit,
  recipeRunIdForVisualPair,
  routeParamString,
} from './components/run-diff-panels';
import { runDiffStyles as styles } from './styles/run-diff.styles';

const emptyRecipeRuns: RecipeRunArtifactGroup[] = [];
export default function DiffViewerScreen() {
  const { runId, path, recipeRun, workspace, decisionKind } = useLocalSearchParams<{
    runId: string;
    path?: string;
    recipeRun?: string;
    workspace?: string | string[];
    decisionKind?: string | string[];
  }>();
  const router = useRouter();
  const focused = useIsFocused();
  const insideReviewPackageTabs = useReviewPackageTab() === 'diff';
  const gatewayUrl = useConnectionStore((s) => s.gatewayUrl);
  const artifactAuthHeaders = useConnectionStore((s) => s.activeProfileHttpAuthHeaders);
  const runQuery = useMemo(
    () => (runId ? resourceQuery<RunGetResult>('run.get', { runId }) : undefined),
    [runId],
  );
  const recipeQuery = useMemo(
    () =>
      runId
        ? resourceQuery<RunRecipeRunsForRunResult>('run.recipeRunsForRun', { runId })
        : undefined,
    [runId],
  );
  const runObservation = useResourceQuery(runQuery);
  const recipeObservation = useResourceQuery(recipeQuery);
  const run = runObservation.data?.run ?? null;
  const recipeRuns = recipeObservation.data?.recipeRuns ?? emptyRecipeRuns;
  const recipeRunsLoaded = Boolean(recipeObservation.data);

  const proofFrame = useRef({ focused, run, recipes: recipeObservation });
  proofFrame.current = { focused, run, recipes: recipeObservation };
  useEffect(() => {
    if (__DEV__) return observeNativeDiffFrame(runId, () => proofFrame.current);
  }, [runId]);

  const requestedRecipeRunId = typeof recipeRun === 'string' ? recipeRun : null;
  const workspaceRouteContext = useMemo(
    () =>
      workspaceRouteContextParams(
        routeParamString(workspace),
        routeParamString(decisionKind),
        'diff',
      ),
    [decisionKind, workspace],
  );
  const selectedRecipeRunId = useMemo(
    () =>
      requestedRecipeRunId && requestedRecipeRunId !== DECISION_EVIDENCE_RECIPE_RUN_PARAM
        ? resolveRecipeRunSelection(
            recipeRuns,
            requestedRecipeRunId,
            recipeObservation.data?.selectedRecipeRunId,
          )
        : null,
    [recipeRuns, requestedRecipeRunId, recipeObservation.data?.selectedRecipeRunId],
  );
  const selectedRecipeRun = useMemo(
    () => recipeRuns.find((group) => group.id === selectedRecipeRunId) ?? null,
    [recipeRuns, selectedRecipeRunId],
  );
  const workspaceRecipeRunId = selectedRecipeRunId ?? requestedRecipeRunId;
  const manifest = useMemo(() => {
    if (selectedRecipeRun) return artifactsForRecipeRun(selectedRecipeRun);
    return run ? extractRunArtifactManifest(run) : [];
  }, [run, selectedRecipeRun]);
  const visualPairSummary = useMemo(
    () =>
      groupVisualArtifactPairs(manifest, (artifact) =>
        artifactUrlForEntry(gatewayUrl, runId, artifact),
      ),
    [gatewayUrl, manifest, runId],
  );
  const recipeFallbackPairSummary = useMemo(() => {
    if (selectedRecipeRun || visualPairSummary.pairs.length > 0) {
      return { pairs: [], singles: [] };
    }
    return groupVisualArtifactPairs(
      selectSlotRecipeArtifactsForPreviewScope(recipeRuns, selectedRecipeRunId),
      (artifact) => artifactUrlForEntry(gatewayUrl, runId, artifact),
    );
  }, [
    gatewayUrl,
    recipeRuns,
    runId,
    selectedRecipeRun,
    selectedRecipeRunId,
    visualPairSummary.pairs.length,
  ]);
  const priorityVisualPairs =
    visualPairSummary.pairs.length > 0 ? visualPairSummary.pairs : recipeFallbackPairSummary.pairs;
  const priorityVisualPair = priorityVisualPairs[0] ?? null;
  const priorityCompareRecipeRunId =
    visualPairSummary.pairs.length > 0
      ? workspaceRecipeRunId
      : recipeRunIdForVisualPair(recipeRuns, priorityVisualPair, selectedRecipeRunId);
  const pathParamError = Array.isArray(path) ? 'Only one diff path can be opened at a time.' : null;
  const requestedDiffPath = !pathParamError && typeof path === 'string' ? path.trim() : '';
  const requestedPathIsDiffArtifact = shouldPreserveArtifactForDiffContext(requestedDiffPath);
  const requestedDiffArtifact = requestedPathIsDiffArtifact
    ? manifest.find((artifact) => artifact.path === requestedDiffPath)
    : undefined;
  const inferredDiffArtifact = requestedPathIsDiffArtifact
    ? undefined
    : diffArtifactCandidate(manifest);
  const diffArtifact: ArtifactManifestEntry | undefined =
    requestedDiffArtifact ??
    (inferredDiffArtifact
      ? { ...inferredDiffArtifact, purpose: inferredDiffArtifact.purpose ?? 'diff' }
      : undefined);
  const diffArtifactPath = requestedPathIsDiffArtifact
    ? requestedDiffPath
    : (diffArtifact?.path ?? '');
  const focusedFilePath = diffFocusedFilePathFromRequest(requestedDiffPath, manifest);
  // An open gate shows its retained package diff, held or verified when opened, before any
  // inferred diff artifact. Without it the screen keeps its artifact and workspace paths.
  const gateDiff = useGateDiffContent(
    selectedRecipeRun || requestedPathIsDiffArtifact ? null : run,
  );
  const gateDiffText = gateDiff.status === 'ready' ? gateDiff.text : '';
  const gateDiffActive = !gateDiffFallsBack(gateDiff);
  // Dev-only recipe evidence: this screen renders its gate's package diff.
  const d12Frame = useRef<RunDiffFrame>({ runId: '', packageDiff: false });
  d12Frame.current = { runId, packageDiff: Boolean(gateDiffText) };
  useEffect(() => {
    if (__DEV__) return observeD12RunDiff(() => d12Frame.current);
  }, []);
  const recipeRunUrlParam =
    selectedRecipeRun && selectedRecipeRun.groupKind !== CURRENT_ARTIFACTS_RECIPE_RUN_PARAM
      ? selectedRecipeRun.id
      : null;
  const diffUrl =
    !gateDiffActive && runId && diffArtifactPath
      ? artifactUrlForEntry(
          gatewayUrl,
          runId,
          diffArtifact ?? {
            path: diffArtifactPath,
            purpose: 'diff',
            ...(recipeRunUrlParam ? { recipeRunId: recipeRunUrlParam } : {}),
          },
        )
      : null;
  const canLoadWorkspaceDiff = Boolean(
    !gateDiffActive && !selectedRecipeRun && run?.slotId && !diffUrl,
  );
  // The run's changes since its base, as prefetch keeps them, online and offline.
  const activeRunDiffQuery = useActiveRunDiffQuery(run);
  const workspaceDiffQuery = canLoadWorkspaceDiff ? activeRunDiffQuery : undefined;
  const workspaceDiffObservation = useResourceQuery(workspaceDiffQuery);
  const workspaceDiffSource = canLoadWorkspaceDiff
    ? (workspaceDiffObservation.data?.diff ?? '')
    : '';
  const currentWorkspaceDiff = {
    loading: workspaceDiffObservation.status === 'loading',
    error: workspaceDiffObservation.error?.message,
  };
  const recipeArtifactCount = recipeRunsLoaded
    ? recipeRuns.reduce((count, group) => count + artifactsForRecipeRun(group).length, 0)
    : null;
  const recipeAvailable = recipeArtifactCount === null ? undefined : recipeArtifactCount > 0;
  const runArtifactCount = run ? extractRunArtifactManifest(run).length : manifest.length;
  const diffAvailable = Boolean(
    gateDiffActive || diffArtifactPath || canLoadWorkspaceDiff || workspaceDiffSource,
  );
  const primaryDecision = selectPrimaryWorkspaceDecision(run);
  const readyDecision = selectReadyWorkspaceDecision(run);
  const reviewGateDecision = selectReviewGateWorkspaceDecision(run);
  const retroDecision = selectRetrospectiveWorkspaceDecision(run);
  const workspaceNavMeta = summarizeRunWorkspaceNavMeta(run);
  const goBackOrRuns = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace('/(tabs)/runs');
  }, [router]);
  const openEvidenceFromDiff = useCallback(() => {
    router.push({
      pathname: '/workspace/run/[runId]/files',
      params: {
        runId,
        workspace: 'artifacts',
        recipeRun:
          priorityCompareRecipeRunId ?? workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
        ...(priorityVisualPair?.after.path ? { artifact: priorityVisualPair.after.path } : {}),
      },
    });
  }, [
    priorityCompareRecipeRunId,
    priorityVisualPair?.after.path,
    router,
    runId,
    workspaceRecipeRunId,
  ]);
  return (
    <SafeAreaView
      edges={insideReviewPackageTabs ? ['bottom'] : ['top', 'bottom']}
      style={baseStyles.container}
    >
      {!insideReviewPackageTabs ? (
        <View style={styles.header}>
          <Pressable style={styles.backButton} onPress={goBackOrRuns}>
            <Text style={styles.backButtonText}>‹ Back</Text>
          </Pressable>
          <View style={styles.headerTitle}>
            <Text style={styles.eyebrow}>Run diff</Text>
            <Text style={styles.title} numberOfLines={2}>
              {focusedFilePath || diffArtifactPath || run?.ticketOrPr || runId}
            </Text>
            {selectedRecipeRun ? (
              <Text style={styles.subtitle} numberOfLines={1}>
                {selectedRecipeRun.label} · {selectedRecipeRun.status}
              </Text>
            ) : null}
          </View>
        </View>
      ) : null}
      <ScrollView
        testID="companion-screen-run-diff"
        collapsable={false}
        style={styles.body}
        contentContainerStyle={styles.bodyContent}
      >
        {!insideReviewPackageTabs ? (
          <RunWorkspaceNav
            dense
            current="diff"
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
            familyId={run?.familyId}
            project={run?.project}
            prNumber={run?.prNumber}
            prRepo={prRepoFromWorkspaceSource(run, run?.prNumber ?? null)}
            recipeRunId={workspaceRecipeRunId}
            artifactPath={diffArtifactPath}
            slotId={run?.slotId}
            runId={runId}
            recipeAvailable={recipeAvailable}
            recipeArtifactCount={recipeArtifactCount}
            diffAvailable={diffAvailable}
            artifactCount={runArtifactCount}
            visualPairCount={priorityVisualPairs.length}
            compareArtifactPath={priorityVisualPair?.after.path ?? null}
            compareRecipeRunId={priorityCompareRecipeRunId}
          />
        ) : null}
        <DiffWorkspaceCockpit
          run={run}
          runId={runId}
          diffPath={diffArtifactPath}
          focusedFilePath={focusedFilePath}
          manifestCount={manifest.length}
          visualPairCount={priorityVisualPairs.length}
          compareArtifactPath={priorityVisualPair?.after.path ?? null}
          recipeRunId={workspaceRecipeRunId}
          compareRecipeRunId={priorityCompareRecipeRunId}
          recipeLabel={selectedRecipeRun?.label}
          readyDecisionId={readyDecision?.id ?? null}
          reviewDecisionId={reviewGateDecision?.id ?? null}
          retroDecisionId={retroDecision?.id ?? null}
          diffSource={
            gateDiffText
              ? 'gate package'
              : diffUrl
                ? 'artifact'
                : canLoadWorkspaceDiff
                  ? 'live workspace'
                  : 'missing'
          }
          workspaceRouteContext={workspaceRouteContext}
        />
        <ResourceReadStatus
          observations={[
            { observation: workspaceDiffObservation, label: 'workspace diff' },
            { observation: runObservation, label: 'run diff' },
            { observation: recipeObservation, label: 'recipe runs' },
          ]}
          onRetry={() => {
            const cache = getResourceCache();
            if (workspaceDiffQuery && cache?.read(workspaceDiffQuery).error)
              void cache.retry(workspaceDiffQuery);
            if (runQuery && cache?.read(runQuery).error) void cache.retry(runQuery);
            if (recipeQuery && cache?.read(recipeQuery).error) void cache.retry(recipeQuery);
          }}
        />
        {pathParamError ? <Text style={styles.errorText}>{pathParamError}</Text> : null}
        {gateDiffText ? (
          <MobileDiffViewer
            title={focusedFilePath ? `${focusedFilePath} · gate package` : 'Gate package diff'}
            diffText={gateDiffText}
            initialPath={focusedFilePath}
            onOpenEvidence={openEvidenceFromDiff}
          />
        ) : gateDiff.status === 'ready' ? (
          <Text style={styles.emptyText}>The gate package has no changes.</Text>
        ) : gateDiff.status === 'mismatch' ? (
          <Text style={styles.errorText}>This diff doesn't match its package.</Text>
        ) : gateDiffActive ? (
          <Text style={styles.emptyText}>Loading gate package diff…</Text>
        ) : diffUrl ? (
          <MobileDiffViewer
            title={diffArtifactPath.split('/').pop() ?? 'Diff'}
            diffUrl={diffUrl}
            initialPath={focusedFilePath}
            fetchHeaders={artifactAuthHeaders}
            onOpenEvidence={openEvidenceFromDiff}
          />
        ) : workspaceDiffSource ? (
          <MobileDiffViewer
            title={focusedFilePath ? `${focusedFilePath} · workspace` : 'Workspace diff'}
            diffText={workspaceDiffSource}
            initialPath={focusedFilePath}
            onOpenEvidence={openEvidenceFromDiff}
          />
        ) : currentWorkspaceDiff?.loading ? (
          <Text style={styles.emptyText}>Loading live workspace diff…</Text>
        ) : currentWorkspaceDiff?.error ? (
          <Text style={styles.errorText}>{currentWorkspaceDiff.error}</Text>
        ) : (
          <Text style={styles.emptyText}>
            No diff artifact or live workspace diff found for{' '}
            {selectedRecipeRun ? 'this recipe run.' : 'this run.'}
          </Text>
        )}
        <View
          testID="companion-screen-run-diff-end"
          accessible
          collapsable={false}
          accessibilityLabel="End of Run diff"
          style={styles.captureEndMarker}
        />
      </ScrollView>
    </SafeAreaView>
  );
}
