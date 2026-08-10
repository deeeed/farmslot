import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Pressable, ScrollView, Text, View } from 'react-native';

import {
  Methods,
  type Run,
  type TaskProgressStructured,
  type TmuxWindow,
} from '@farmslot/protocol';

import { BeforeAfterPreview } from '../../../components/BeforeAfterPreview';
import {
  type ArtifactHttpHeaders,
  DECISION_EVIDENCE_RECIPE_RUN_PARAM,
  type VisualArtifactPair,
} from '../../../lib/artifact-url';
import { diffArtifactCandidate } from '../../../lib/diff';
import { prRepoFromWorkspaceSource } from '../../../lib/pr-links';
import { fallbackTaskProgressSummary, taskProgressPercent } from '../../../lib/task-progress';
import { colors } from '../../../lib/theme';
import { summarizeRunWorkspaceNavMeta } from '../../../lib/workspace-nav-meta';
import {
  artifactFilterParamForArtifactPath,
  artifactFilterParamForWorkspaceNav,
  decisionWorkspaceRouteParams,
  familySectionRouteContextParams,
  recipeWorkspaceParam,
  recipeWorkspaceScopeLabel,
  shouldPreserveArtifactForDecisionEvidenceContext,
  shouldPreserveArtifactForRecipeContext,
  targetWorkspaceForArtifactRoute,
  targetWorkspaceRouteContextParams,
  type WorkspaceRouteContext,
} from '../../../lib/workspace-navigation';
import { slotTerminalStyles as styles } from '../styles/slot-terminal.styles';

export function TerminalSteeringContextCard({
  slotId,
  run,
  fallbackRunId,
  streamLabel,
  liveBadgeColor,
  targetWarning,
  terminalInputDisabled,
  voiceRecorderBusy,
  onOpenKeyboard,
  onOpenTmux,
  onOpenContext,
  onOpenVoice,
}: {
  slotId?: string;
  run: Run | null;
  fallbackRunId?: string;
  streamLabel: string;
  liveBadgeColor: string;
  targetWarning?: string | null;
  terminalInputDisabled: boolean;
  voiceRecorderBusy: boolean;
  onOpenKeyboard: () => void;
  onOpenTmux: () => void;
  onOpenContext: () => void;
  onOpenVoice: () => void;
}) {
  return (
    <View style={styles.steeringContextCard}>
      <View style={styles.steeringContextHeader}>
        <View style={styles.steeringContextCopy}>
          <Text style={styles.steeringContextEyebrow}>Contextual steering</Text>
          <Text style={styles.steeringContextTitle} numberOfLines={2}>
            {run?.ticketOrPr ?? fallbackRunId ?? slotId ?? 'Worker terminal'}
          </Text>
          <Text style={styles.steeringContextText} numberOfLines={2}>
            {slotId ? `Connected to ${slotId}` : 'No slot selected'}
            {run?.status ? ` · ${run.status}` : ''}
            {run?.prNumber ? ` · PR #${run.prNumber}` : ''}
          </Text>
        </View>
        <View
          style={[
            styles.steeringStatusPill,
            {
              borderColor: liveBadgeColor + '88',
              backgroundColor: liveBadgeColor + '16',
            },
          ]}
        >
          <Text style={[styles.steeringStatusText, { color: liveBadgeColor }]}>{streamLabel}</Text>
        </View>
      </View>
      {targetWarning ? <Text style={styles.steeringWarningText}>{targetWarning}</Text> : null}
      <View style={styles.steeringActionRail}>
        <Pressable
          style={styles.steeringActionButton}
          onPress={onOpenKeyboard}
          disabled={terminalInputDisabled}
        >
          <Ionicons name="keypad-outline" size={15} color={colors.accent} />
          <Text style={styles.steeringActionText}>Keyboard</Text>
        </Pressable>
        <Pressable
          style={styles.steeringActionButton}
          onPress={onOpenTmux}
          disabled={terminalInputDisabled}
        >
          <Ionicons name="albums-outline" size={15} color={colors.accent} />
          <Text style={styles.steeringActionText}>Tmux</Text>
        </Pressable>
        <Pressable style={styles.steeringActionButton} onPress={onOpenContext}>
          <Ionicons name="copy-outline" size={15} color={colors.accent} />
          <Text style={styles.steeringActionText}>Context</Text>
        </Pressable>
        <Pressable
          style={styles.steeringActionButton}
          onPress={onOpenVoice}
          disabled={voiceRecorderBusy}
        >
          <Ionicons name="mic-outline" size={15} color={colors.accent} />
          <Text style={styles.steeringActionText}>Voice nudge</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function TerminalWorkspaceCockpit({
  slotId,
  run,
  fallbackRunId,
  recipeRunId,
  focusedArtifactPath,
  artifactCount,
  visualPairCount,
  comparePair,
  compareArtifactPath,
  compareRecipeRunId,
  artifactAuthHeaders,
  recipeArtifactCount,
  recipeAvailable,
  diffArtifactPath,
  diffAvailable,
  readyDecisionId,
  reviewDecisionId,
  retroDecisionId,
  streamLabel,
  lineCount,
  lastUpdatedLabel,
  activeTaskProgress,
  fallbackTaskProgress,
  workspaceRouteContext,
}: {
  slotId: string;
  run: Run | null;
  fallbackRunId?: string;
  recipeRunId: string;
  focusedArtifactPath: string | null;
  artifactCount: number;
  visualPairCount: number;
  comparePair: VisualArtifactPair | null;
  compareArtifactPath: string | null;
  compareRecipeRunId: string;
  artifactAuthHeaders: ArtifactHttpHeaders;
  recipeArtifactCount: number | null;
  recipeAvailable?: boolean;
  diffArtifactPath: string | null;
  diffAvailable?: boolean;
  readyDecisionId: string | null;
  reviewDecisionId: string | null;
  retroDecisionId: string | null;
  streamLabel: string;
  lineCount: number;
  lastUpdatedLabel: string;
  activeTaskProgress: TaskProgressStructured | null;
  fallbackTaskProgress: ReturnType<typeof fallbackTaskProgressSummary> | null;
  workspaceRouteContext: WorkspaceRouteContext;
}) {
  const router = useRouter();
  const targetRunId = run?.id ?? fallbackRunId ?? null;
  const artifactRecipeRun = recipeRunId || DECISION_EVIDENCE_RECIPE_RUN_PARAM;
  const focusedArtifactRecipeRun = recipeRunId || DECISION_EVIDENCE_RECIPE_RUN_PARAM;
  const focusedArtifactIsDiff = Boolean(
    focusedArtifactPath && diffArtifactCandidate([{ path: focusedArtifactPath }]),
  );
  const diffRouteContext = targetWorkspaceRouteContextParams(
    'diff',
    workspaceRouteContext.decisionKind,
  );
  const targetRouteContext = (
    targetWorkspace: Parameters<typeof targetWorkspaceRouteContextParams>[0],
  ) => targetWorkspaceRouteContextParams(targetWorkspace, workspaceRouteContext.decisionKind);
  const recipeTarget = recipeWorkspaceParam(recipeRunId);
  const openRun = () => {
    if (!targetRunId) return;
    router.push({
      pathname: '/workspace/run/[runId]/evidence',
      params: {
        runId: targetRunId,
        ...targetRouteContext('run'),
        ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
        ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
      },
    });
  };
  const openScopedArtifacts = () => {
    if (!targetRunId) return;
    const targetFilter =
      artifactRecipeRun !== DECISION_EVIDENCE_RECIPE_RUN_PARAM
        ? artifactFilterParamForWorkspaceNav('recipe')
        : ((focusedArtifactPath ? artifactFilterParamForArtifactPath(focusedArtifactPath) : null) ??
          artifactFilterParamForWorkspaceNav('review'));
    router.push({
      pathname: '/workspace/run/[runId]/files',
      params: {
        runId: targetRunId,
        ...targetRouteContext(targetWorkspaceForArtifactRoute(artifactRecipeRun, targetFilter)),
        recipeRun: artifactRecipeRun,
        ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
        filter: targetFilter,
      },
    });
  };
  const openEvidenceArtifacts = () => {
    if (!targetRunId) return;
    const evidenceArtifactPath = shouldPreserveArtifactForDecisionEvidenceContext(
      focusedArtifactRecipeRun,
      focusedArtifactPath,
    )
      ? focusedArtifactPath
      : null;
    const targetFilter =
      (evidenceArtifactPath ? artifactFilterParamForArtifactPath(evidenceArtifactPath) : null) ??
      artifactFilterParamForWorkspaceNav('review');
    router.push({
      pathname: '/workspace/run/[runId]/files',
      params: {
        runId: targetRunId,
        ...targetRouteContext(
          targetWorkspaceForArtifactRoute(DECISION_EVIDENCE_RECIPE_RUN_PARAM, targetFilter),
        ),
        recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
        filter: targetFilter,
        ...(evidenceArtifactPath ? { artifact: evidenceArtifactPath } : {}),
      },
    });
  };
  const openCompareArtifacts = () => {
    if (!targetRunId || !compareArtifactPath) return;
    router.push({
      pathname: '/workspace/run/[runId]/files',
      params: {
        runId: targetRunId,
        ...targetRouteContext('compare'),
        recipeRun: compareRecipeRunId,
        filter: artifactFilterParamForWorkspaceNav('compare'),
        artifact: compareArtifactPath,
      },
    });
  };
  const openCompareArtifact = (artifactPath: string) => {
    if (!targetRunId) return;
    router.push({
      pathname: '/workspace/run/[runId]/files',
      params: {
        runId: targetRunId,
        ...targetRouteContext('compare'),
        recipeRun: compareRecipeRunId,
        filter: artifactFilterParamForWorkspaceNav('compare'),
        artifact: artifactPath,
      },
    });
  };
  const openRecipe = () => {
    if (!targetRunId || recipeAvailable === false) return;
    router.push({
      pathname: '/workspace/run/[runId]/files',
      params: {
        runId: targetRunId,
        ...targetRouteContext('recipe'),
        recipeRun: recipeTarget,
        filter: artifactFilterParamForWorkspaceNav('recipe'),
        ...(shouldPreserveArtifactForRecipeContext(recipeTarget, focusedArtifactPath)
          ? { artifact: focusedArtifactPath }
          : {}),
      },
    });
  };
  const openDiff = () => {
    if (targetRunId && diffAvailable !== false) {
      router.push({
        pathname: '/workspace/run/[runId]/diff',
        params: {
          runId: targetRunId,
          ...diffRouteContext,
          ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
          ...(focusedArtifactIsDiff
            ? { path: focusedArtifactPath }
            : diffArtifactPath
              ? { path: diffArtifactPath }
              : {}),
        },
      });
      return;
    }
    router.push({
      pathname: '/workspace/slot/[slotId]/diff',
      params: {
        slotId,
        ...diffRouteContext,
        ...(focusedArtifactIsDiff
          ? { path: focusedArtifactPath }
          : diffArtifactPath
            ? { path: diffArtifactPath }
            : {}),
      },
    });
  };
  const openSlot = () => {
    router.push({
      pathname: '/workspace/slot/[slotId]/slot',
      params: {
        slotId: slotId,
        ...targetRouteContext('slot'),
        ...(targetRunId ? { runId: targetRunId } : {}),
        ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
        ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
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
        ...familySectionRouteContextParams('focus', workspaceRouteContext.decisionKind),
        ...(targetRunId ? { runId: targetRunId } : {}),
        ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
        ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
        section: 'focus',
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
        ...(targetRunId ? { runId: targetRunId } : {}),
        ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
        ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
        section: 'retros',
      },
    });
  };
  const openDecision = (decisionId: string | null) => {
    if (!decisionId) return;
    const decisionRouteContext = decisionWorkspaceRouteParams(
      decisionId === readyDecisionId
        ? 'ready'
        : decisionId === retroDecisionId
          ? 'retrospective'
          : 'review',
    );
    router.push({
      pathname: '/decision/[id]',
      params: {
        id: decisionId,
        ...decisionRouteContext,
        ...(targetRunId ? { runId: targetRunId } : {}),
        ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
        ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
      },
    });
  };
  const openFocusedArtifact = () => {
    if (!targetRunId || !focusedArtifactPath) return;
    if (focusedArtifactIsDiff) {
      openDiff();
      return;
    }
    router.push({
      pathname: '/workspace/run/[runId]/files',
      params: {
        runId: targetRunId,
        ...targetRouteContext(
          targetWorkspaceForArtifactRoute(
            focusedArtifactRecipeRun,
            artifactFilterParamForArtifactPath(focusedArtifactPath) ??
              (focusedArtifactRecipeRun !== DECISION_EVIDENCE_RECIPE_RUN_PARAM
                ? artifactFilterParamForWorkspaceNav('recipe')
                : artifactFilterParamForWorkspaceNav('review')),
          ),
        ),
        recipeRun: focusedArtifactRecipeRun,
        artifact: focusedArtifactPath,
        filter:
          artifactFilterParamForArtifactPath(focusedArtifactPath) ??
          (focusedArtifactRecipeRun !== DECISION_EVIDENCE_RECIPE_RUN_PARAM
            ? artifactFilterParamForWorkspaceNav('recipe')
            : artifactFilterParamForWorkspaceNav('review')),
      },
    });
  };
  const focusedArtifactKind = focusedArtifactPath
    ? terminalFocusedArtifactKindLabel(focusedArtifactPath)
    : null;
  const focusedArtifactRecipeScoped =
    focusedArtifactRecipeRun !== DECISION_EVIDENCE_RECIPE_RUN_PARAM;
  const openPR = () => {
    if (!run?.prNumber) return;
    const prRepo = prRepoFromWorkspaceSource(run, run.prNumber);
    router.push({
      pathname: '/(tabs)/prs',
      params: {
        pr: String(run.prNumber),
        ...targetRouteContext('pr'),
        ...(prRepo ? { repo: prRepo } : {}),
      },
    });
  };
  const progressValue = activeTaskProgress
    ? `${Math.round(taskProgressPercent(activeTaskProgress))}%`
    : fallbackTaskProgress?.percent != null
      ? `${Math.round(fallbackTaskProgress.percent)}%`
      : fallbackTaskProgress
        ? 'live'
        : '-';
  return (
    <View style={styles.terminalCockpitPanel}>
      <View style={styles.terminalCockpitHeader}>
        <View style={styles.terminalCockpitTitleBlock}>
          <Text style={styles.terminalCockpitTitle}>Terminal cockpit</Text>
          <Text style={styles.terminalCockpitMeta} numberOfLines={1}>
            {run?.ticketOrPr ?? slotId} · {streamLabel}
          </Text>
        </View>
        <Pressable
          style={[styles.terminalCockpitPill, !targetRunId && styles.terminalCockpitDisabled]}
          disabled={!targetRunId}
          onPress={openRun}
        >
          <Text style={styles.terminalCockpitPillText}>Run</Text>
        </Pressable>
      </View>
      {focusedArtifactPath ? (
        <View style={styles.terminalFocusedArtifactCard}>
          <View style={styles.terminalCockpitHeader}>
            <View style={styles.terminalCockpitTitleBlock}>
              <Text style={styles.terminalFocusedArtifactEyebrow}>Focused artifact</Text>
              <Text style={styles.terminalFocusedArtifactPath} numberOfLines={2}>
                {focusedArtifactPath}
              </Text>
              <Text style={styles.terminalFocusedArtifactMeta} numberOfLines={1}>
                {focusedArtifactKind} ·{' '}
                {focusedArtifactRecipeScoped ? 'recipe context' : 'decision evidence'}
              </Text>
            </View>
            <Pressable
              style={[styles.terminalCockpitPill, !targetRunId && styles.terminalCockpitDisabled]}
              disabled={!targetRunId}
              onPress={openFocusedArtifact}
            >
              <Text style={styles.terminalCockpitPillText}>
                {focusedArtifactIsDiff ? 'Open diff' : 'Open'}
              </Text>
            </Pressable>
          </View>
          <View style={styles.terminalCockpitActions}>
            <Pressable
              style={[styles.terminalCockpitAction, !targetRunId && styles.terminalCockpitDisabled]}
              disabled={!targetRunId}
              onPress={openScopedArtifacts}
            >
              <Text style={styles.terminalCockpitActionText}>Files context</Text>
            </Pressable>
            <Pressable
              style={[
                styles.terminalCockpitAction,
                (!targetRunId || recipeAvailable === false) && styles.terminalCockpitDisabled,
              ]}
              disabled={!targetRunId || recipeAvailable === false}
              onPress={openRecipe}
            >
              <Text style={styles.terminalCockpitActionText}>Recipe files</Text>
            </Pressable>
            <Pressable
              style={[
                styles.terminalCockpitAction,
                (!targetRunId || visualPairCount === 0) && styles.terminalCockpitDisabled,
              ]}
              disabled={!targetRunId || visualPairCount === 0}
              onPress={openCompareArtifacts}
            >
              <Text style={styles.terminalCockpitActionText}>Before→After</Text>
            </Pressable>
            <Pressable
              style={[
                styles.terminalCockpitAction,
                !targetRunId && !slotId && styles.terminalCockpitDisabled,
              ]}
              disabled={!targetRunId && !slotId}
              onPress={openDiff}
            >
              <Text style={styles.terminalCockpitActionText}>
                {focusedArtifactIsDiff ? 'Focused diff' : 'Run diff'}
              </Text>
            </Pressable>
            <Pressable
              style={[styles.terminalCockpitAction, !targetRunId && styles.terminalCockpitDisabled]}
              disabled={!targetRunId}
              onPress={openRun}
            >
              <Text style={styles.terminalCockpitActionText}>Run detail</Text>
            </Pressable>
            <Pressable style={styles.terminalCockpitAction} onPress={openSlot}>
              <Text style={styles.terminalCockpitActionText}>Slot</Text>
            </Pressable>
            <Pressable
              style={[
                styles.terminalCockpitAction,
                !run?.familyId && styles.terminalCockpitDisabled,
              ]}
              disabled={!run?.familyId}
              onPress={openFamily}
            >
              <Text style={styles.terminalCockpitActionText}>Family</Text>
            </Pressable>
            <Pressable
              style={[
                styles.terminalCockpitAction,
                !run?.familyId && styles.terminalCockpitDisabled,
              ]}
              disabled={!run?.familyId}
              onPress={openFamilyRetros}
            >
              <Text style={styles.terminalCockpitActionText}>Family retros</Text>
            </Pressable>
            <Pressable
              style={[
                styles.terminalCockpitAction,
                !run?.prNumber && styles.terminalCockpitDisabled,
              ]}
              disabled={!run?.prNumber}
              onPress={openPR}
            >
              <Text style={styles.terminalCockpitActionText}>PR</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      <View style={styles.terminalCockpitCompactRow}>
        <Text style={styles.terminalCockpitCompactMeta} numberOfLines={1}>
          Tail {lineCount} · {lastUpdatedLabel}
        </Text>
        <Text style={styles.terminalCockpitCompactMeta} numberOfLines={1}>
          Files {artifactCount} · Recipe {recipeArtifactCount ?? '-'}
        </Text>
        <Text style={styles.terminalCockpitCompactMeta} numberOfLines={1}>
          Progress {progressValue}
        </Text>
      </View>
      <View style={styles.terminalCockpitActions}>
        <Pressable
          style={[styles.terminalCockpitAction, !targetRunId && styles.terminalCockpitDisabled]}
          disabled={!targetRunId}
          onPress={openEvidenceArtifacts}
        >
          <Text style={styles.terminalCockpitActionText}>Files</Text>
        </Pressable>
        <Pressable
          style={[
            styles.terminalCockpitAction,
            (!targetRunId || recipeAvailable === false) && styles.terminalCockpitDisabled,
          ]}
          disabled={!targetRunId || recipeAvailable === false}
          onPress={openRecipe}
        >
          <Text style={styles.terminalCockpitActionText}>Recipe</Text>
        </Pressable>
        <Pressable
          style={[
            styles.terminalCockpitAction,
            !targetRunId && !slotId && styles.terminalCockpitDisabled,
          ]}
          disabled={!targetRunId && !slotId}
          onPress={openDiff}
        >
          <Text style={styles.terminalCockpitActionText}>Diff</Text>
        </Pressable>
        <Pressable style={styles.terminalCockpitAction} onPress={openSlot}>
          <Text style={styles.terminalCockpitActionText}>Slot</Text>
        </Pressable>
        <Pressable
          style={[styles.terminalCockpitAction, !readyDecisionId && styles.terminalCockpitDisabled]}
          disabled={!readyDecisionId}
          onPress={() => openDecision(readyDecisionId)}
        >
          <Text style={styles.terminalCockpitActionText}>Ready</Text>
        </Pressable>
        <Pressable
          style={[
            styles.terminalCockpitAction,
            !reviewDecisionId && styles.terminalCockpitDisabled,
          ]}
          disabled={!reviewDecisionId}
          onPress={() => openDecision(reviewDecisionId)}
        >
          <Text style={styles.terminalCockpitActionText}>Review</Text>
        </Pressable>
        <Pressable
          style={[styles.terminalCockpitAction, !run?.familyId && styles.terminalCockpitDisabled]}
          disabled={!run?.familyId}
          onPress={openFamily}
        >
          <Text style={styles.terminalCockpitActionText}>Family</Text>
        </Pressable>
        <Pressable
          style={[styles.terminalCockpitAction, !run?.prNumber && styles.terminalCockpitDisabled]}
          disabled={!run?.prNumber}
          onPress={openPR}
        >
          <Text style={styles.terminalCockpitActionText}>PR</Text>
        </Pressable>
      </View>
      {comparePair ? (
        <BeforeAfterPreview
          pair={comparePair}
          authHeaders={artifactAuthHeaders}
          onOpenArtifact={openCompareArtifact}
          eyebrow={
            compareRecipeRunId === DECISION_EVIDENCE_RECIPE_RUN_PARAM
              ? 'Run evidence'
              : 'Recipe evidence'
          }
          title={
            compareRecipeRunId === DECISION_EVIDENCE_RECIPE_RUN_PARAM
              ? 'Terminal before → after'
              : 'Recipe before → after'
          }
          hint="Tap to inspect"
          imageHeight={66}
        />
      ) : null}
    </View>
  );
}
export function TerminalFullscreenWorkspaceRail({
  top,
  slotId,
  run,
  fallbackRunId,
  recipeRunId,
  recipeAvailable,
  diffAvailable,
  diffArtifactPath,
  focusedArtifactPath,
  visualPairCount,
  compareArtifactPath,
  compareRecipeRunId,
  readyDecisionId,
  reviewDecisionId,
  retroDecisionId,
  activeTaskProgress,
  fallbackTaskProgress,
  workspaceRouteContext,
}: {
  top: number;
  slotId: string;
  run: Run | null;
  fallbackRunId?: string;
  recipeRunId: string;
  recipeAvailable?: boolean;
  diffAvailable?: boolean;
  diffArtifactPath: string | null;
  focusedArtifactPath: string | null;
  visualPairCount: number;
  compareArtifactPath: string | null;
  compareRecipeRunId: string;
  readyDecisionId: string | null;
  reviewDecisionId: string | null;
  retroDecisionId: string | null;
  activeTaskProgress: TaskProgressStructured | null;
  fallbackTaskProgress: ReturnType<typeof fallbackTaskProgressSummary> | null;
  workspaceRouteContext: WorkspaceRouteContext;
}) {
  const router = useRouter();
  const workspaceNavMeta = summarizeRunWorkspaceNavMeta(run);
  const targetRunId = run?.id ?? fallbackRunId ?? null;
  const recipeScopeLabel = recipeWorkspaceScopeLabel(recipeRunId);
  const focusedArtifactIsDiff = Boolean(
    focusedArtifactPath && diffArtifactCandidate([{ path: focusedArtifactPath }]),
  );
  const diffRouteContext = targetWorkspaceRouteContextParams(
    'diff',
    workspaceRouteContext.decisionKind,
  );
  const targetRouteContext = (
    targetWorkspace: Parameters<typeof targetWorkspaceRouteContextParams>[0],
  ) => targetWorkspaceRouteContextParams(targetWorkspace, workspaceRouteContext.decisionKind);
  const openSlot = () => {
    router.push({
      pathname: '/workspace/slot/[slotId]/slot',
      params: {
        slotId: slotId,
        ...targetRouteContext('slot'),
        ...(targetRunId ? { runId: targetRunId } : {}),
        ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
        ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
      },
    });
  };
  const openRun = () => {
    if (!targetRunId) return;
    router.push({
      pathname: '/workspace/run/[runId]/evidence',
      params: {
        runId: targetRunId,
        ...targetRouteContext('run'),
        ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
        ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
      },
    });
  };
  const openScopedArtifacts = () => {
    if (!targetRunId) return;
    const artifactRecipeRun = recipeRunId || DECISION_EVIDENCE_RECIPE_RUN_PARAM;
    const targetFilter =
      artifactRecipeRun !== DECISION_EVIDENCE_RECIPE_RUN_PARAM
        ? artifactFilterParamForWorkspaceNav('recipe')
        : ((focusedArtifactPath ? artifactFilterParamForArtifactPath(focusedArtifactPath) : null) ??
          artifactFilterParamForWorkspaceNav('review'));
    router.push({
      pathname: '/workspace/run/[runId]/files',
      params: {
        runId: targetRunId,
        ...targetRouteContext(targetWorkspaceForArtifactRoute(artifactRecipeRun, targetFilter)),
        recipeRun: artifactRecipeRun,
        filter: targetFilter,
        ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
      },
    });
  };
  const openEvidenceArtifacts = () => {
    if (!targetRunId) return;
    const focusedArtifactRecipeRun = recipeRunId || DECISION_EVIDENCE_RECIPE_RUN_PARAM;
    const evidenceArtifactPath = shouldPreserveArtifactForDecisionEvidenceContext(
      focusedArtifactRecipeRun,
      focusedArtifactPath,
    )
      ? focusedArtifactPath
      : null;
    const targetFilter =
      (evidenceArtifactPath ? artifactFilterParamForArtifactPath(evidenceArtifactPath) : null) ??
      artifactFilterParamForWorkspaceNav('review');
    router.push({
      pathname: '/workspace/run/[runId]/files',
      params: {
        runId: targetRunId,
        ...targetRouteContext(
          targetWorkspaceForArtifactRoute(DECISION_EVIDENCE_RECIPE_RUN_PARAM, targetFilter),
        ),
        recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
        filter: targetFilter,
        ...(evidenceArtifactPath ? { artifact: evidenceArtifactPath } : {}),
      },
    });
  };
  const openCompare = () => {
    if (!targetRunId || !compareArtifactPath || visualPairCount === 0) return;
    router.push({
      pathname: '/workspace/run/[runId]/files',
      params: {
        runId: targetRunId,
        ...targetRouteContext('compare'),
        recipeRun: compareRecipeRunId,
        filter: artifactFilterParamForWorkspaceNav('compare'),
        artifact: compareArtifactPath,
      },
    });
  };
  const openRecipe = () => {
    if (!targetRunId || recipeAvailable === false) return;
    const recipeTarget = recipeWorkspaceParam(recipeRunId);
    router.push({
      pathname: '/workspace/run/[runId]/files',
      params: {
        runId: targetRunId,
        ...targetRouteContext('recipe'),
        recipeRun: recipeTarget,
        filter: artifactFilterParamForWorkspaceNav('recipe'),
        ...(shouldPreserveArtifactForRecipeContext(recipeTarget, focusedArtifactPath)
          ? { artifact: focusedArtifactPath }
          : {}),
      },
    });
  };
  const openDiff = () => {
    if (targetRunId && diffAvailable !== false) {
      router.push({
        pathname: '/workspace/run/[runId]/diff',
        params: {
          runId: targetRunId,
          ...diffRouteContext,
          ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
          ...(focusedArtifactIsDiff
            ? { path: focusedArtifactPath }
            : diffArtifactPath
              ? { path: diffArtifactPath }
              : {}),
        },
      });
      return;
    }
    router.push({
      pathname: '/workspace/slot/[slotId]/diff',
      params: {
        slotId,
        ...diffRouteContext,
        ...(focusedArtifactIsDiff ? { path: focusedArtifactPath } : {}),
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
        ...familySectionRouteContextParams('focus', workspaceRouteContext.decisionKind),
        ...(targetRunId ? { runId: targetRunId } : {}),
        ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
        ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
        section: 'focus',
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
        ...(targetRunId ? { runId: targetRunId } : {}),
        ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
        ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
        section: 'retros',
      },
    });
  };
  const openPR = () => {
    if (!run?.prNumber) return;
    const prRepo = prRepoFromWorkspaceSource(run, run.prNumber);
    router.push({
      pathname: '/(tabs)/prs',
      params: {
        pr: String(run.prNumber),
        ...targetRouteContext('pr'),
        ...(prRepo ? { repo: prRepo } : {}),
      },
    });
  };
  const openDecision = (decisionId: string | null) => {
    if (!decisionId) return;
    const decisionRouteContext = decisionWorkspaceRouteParams(
      decisionId === readyDecisionId
        ? 'ready'
        : decisionId === retroDecisionId
          ? 'retrospective'
          : 'review',
    );
    router.push({
      pathname: '/decision/[id]',
      params: {
        id: decisionId,
        ...decisionRouteContext,
        ...(targetRunId ? { runId: targetRunId } : {}),
        ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
        ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
      },
    });
  };
  const openFocusedArtifact = () => {
    if (focusedArtifactIsDiff) {
      openDiff();
      return;
    }
    openScopedArtifacts();
  };
  const progressValue = activeTaskProgress
    ? `${Math.round(taskProgressPercent(activeTaskProgress))}%`
    : fallbackTaskProgress?.percent != null
      ? `${Math.round(fallbackTaskProgress.percent)}%`
      : fallbackTaskProgress
        ? 'live'
        : '-';
  return (
    <View style={[styles.fullscreenWorkspaceRail, { top }]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.fullscreenWorkspaceRailContent}
      >
        <FullscreenNavPill label="Slot" value={slotId} onPress={openSlot} />
        <FullscreenNavPill
          label="Run"
          value={targetRunId ? 'detail' : '-'}
          onPress={openRun}
          disabled={!targetRunId}
        />
        {focusedArtifactPath ? (
          <FullscreenNavPill
            label="Focus"
            value={focusedArtifactIsDiff ? 'diff' : 'artifact'}
            onPress={openFocusedArtifact}
            disabled={!targetRunId && !focusedArtifactIsDiff}
          />
        ) : null}
        <FullscreenNavPill
          label="Evidence"
          value={targetRunId ? 'files' : '-'}
          onPress={openEvidenceArtifacts}
          disabled={!targetRunId}
        />
        {visualPairCount > 0 ? (
          <FullscreenNavPill
            label="Compare"
            value={`${visualPairCount}`}
            onPress={openCompare}
            disabled={!targetRunId || !compareArtifactPath}
          />
        ) : null}
        <FullscreenNavPill
          label="Recipe"
          value={recipeAvailable === false ? '-' : recipeScopeLabel}
          onPress={openRecipe}
          disabled={!targetRunId || recipeAvailable === false}
        />
        <FullscreenNavPill
          label="Diff"
          value={diffAvailable === false ? 'slot' : 'run'}
          onPress={openDiff}
        />
        <FullscreenNavPill
          label="Progress"
          value={progressValue}
          disabled={!activeTaskProgress && !fallbackTaskProgress}
        />
        {readyDecisionId ? (
          <FullscreenNavPill
            label="Ready"
            value={workspaceNavMeta.readyMeta ?? 'gate'}
            onPress={() => openDecision(readyDecisionId)}
          />
        ) : null}
        {reviewDecisionId ? (
          <FullscreenNavPill
            label="Review"
            value={workspaceNavMeta.reviewMeta ?? 'gate'}
            onPress={() => openDecision(reviewDecisionId)}
          />
        ) : null}
        {retroDecisionId ? (
          <FullscreenNavPill
            label="Retro"
            value={workspaceNavMeta.retroMeta ?? 'gate'}
            onPress={() => openDecision(retroDecisionId)}
          />
        ) : null}
        <FullscreenNavPill
          label="Family"
          value={run?.familyId ? 'open' : '-'}
          onPress={openFamily}
          disabled={!run?.familyId}
        />
        <FullscreenNavPill
          label="Family retros"
          value={run?.familyId ? 'open' : '-'}
          onPress={openFamilyRetros}
          disabled={!run?.familyId}
        />
        <FullscreenNavPill
          label="PR"
          value={run?.prNumber ? `#${run.prNumber}` : '-'}
          onPress={openPR}
          disabled={!run?.prNumber}
        />
      </ScrollView>
    </View>
  );
}
export function FullscreenNavPill({
  label,
  value,
  onPress,
  disabled = false,
}: {
  label: string;
  value: string;
  onPress?: () => void;
  disabled?: boolean;
}) {
  const content = (
    <>
      <Text style={styles.fullscreenNavPillLabel}>{label}</Text>
      <Text style={styles.fullscreenNavPillValue} numberOfLines={1}>
        {value}
      </Text>
    </>
  );
  if (!onPress) {
    return (
      <View style={[styles.fullscreenNavPill, disabled && styles.fullscreenNavPillDisabled]}>
        {content}
      </View>
    );
  }
  return (
    <Pressable
      style={[styles.fullscreenNavPill, disabled && styles.fullscreenNavPillDisabled]}
      onPress={onPress}
      disabled={disabled}
    >
      {content}
    </Pressable>
  );
}
export function terminalFocusedArtifactKindLabel(artifactPath: string): string {
  if (diffArtifactCandidate([{ path: artifactPath }])) return 'diff';
  const filter = artifactFilterParamForArtifactPath(artifactPath);
  if (filter === 'recipes') return 'recipe file';
  if (filter === 'visual') return 'visual evidence';
  return 'evidence file';
}
export type MobileTmuxActionMethod =
  | typeof Methods.TMUX_SPLIT
  | typeof Methods.TMUX_SELECT_PANE
  | typeof Methods.TMUX_KILL_PANE
  | typeof Methods.TMUX_ZOOM_PANE
  | typeof Methods.TMUX_NEW_WINDOW
  | typeof Methods.TMUX_SELECT_WINDOW
  | typeof Methods.TMUX_SEND_KEYS
  | typeof Methods.TMUX_SYNCHRONIZE_PANES;
export function TmuxControlPanel({
  windows,
  activeAction,
  disabled,
  onRefresh,
  onAction,
}: {
  windows: TmuxWindow[];
  activeAction: string | null;
  disabled: boolean;
  onRefresh: () => void;
  onAction: (
    label: string,
    method: MobileTmuxActionMethod,
    params?: Record<string, unknown>,
  ) => void;
}) {
  const activeWindow = windows.find((window) => window.active) ?? null;
  const activePaneCount = activeWindow?.panes.length ?? 0;
  const activeSyncEnabled = Boolean(activeWindow?.synchronizePanes);
  const actionDisabled = disabled || Boolean(activeAction);
  const renderTmuxButton = (
    label: string,
    method: MobileTmuxActionMethod,
    params: Record<string, unknown> = {},
    danger = false,
  ) => (
    <Pressable
      key={label}
      style={[
        styles.controlButton,
        styles.tmuxButton,
        danger && styles.interruptButton,
        actionDisabled && styles.disabledButton,
      ]}
      disabled={actionDisabled}
      onPress={() => onAction(label, method, params)}
    >
      <Text style={[styles.controlButtonText, danger && styles.interruptButtonText]}>
        {activeAction === label ? '…' : label}
      </Text>
    </Pressable>
  );
  return (
    <View style={styles.tmuxPanel}>
      <View style={styles.tmuxPanelHeader}>
        <Text style={styles.controlLabel}>
          Tmux panes / windows{' '}
          {activeWindow
            ? `· ${activeWindow.name} · ${activePaneCount} pane${activePaneCount === 1 ? '' : 's'}${
                activeSyncEnabled ? ' · sync on' : ''
              }`
            : ''}
        </Text>
        <Pressable style={styles.tmuxRefreshButton} onPress={onRefresh} disabled={actionDisabled}>
          <Text style={styles.tmuxRefreshText}>Refresh</Text>
        </Pressable>
      </View>
      <View style={styles.controlRow}>
        {renderTmuxButton('Split →', Methods.TMUX_SPLIT, { direction: 'h' })}
        {renderTmuxButton('Split ↓', Methods.TMUX_SPLIT, { direction: 'v' })}
        {renderTmuxButton('Pane ↑', Methods.TMUX_SELECT_PANE, { direction: 'U' })}
        {renderTmuxButton('Pane ↓', Methods.TMUX_SELECT_PANE, { direction: 'D' })}
        {renderTmuxButton('Pane ←', Methods.TMUX_SELECT_PANE, { direction: 'L' })}
        {renderTmuxButton('Pane →', Methods.TMUX_SELECT_PANE, { direction: 'R' })}
        {renderTmuxButton('Zoom', Methods.TMUX_ZOOM_PANE)}
        {renderTmuxButton(
          activeSyncEnabled ? 'Sync panes off' : 'Sync panes on',
          Methods.TMUX_SYNCHRONIZE_PANES,
          {
            enabled: !activeSyncEnabled,
          },
        )}
        {renderTmuxButton('New win', Methods.TMUX_NEW_WINDOW)}
        {renderTmuxButton('Prefix', Methods.TMUX_SEND_KEYS, { keys: 'C-b' })}
        {renderTmuxButton('Kill pane', Methods.TMUX_KILL_PANE, {}, true)}
      </View>
      {windows.length > 0 ? (
        <View style={styles.controlRow}>
          {windows.map((window) => (
            <Pressable
              key={window.index}
              style={[
                styles.controlButton,
                styles.tmuxWindowButton,
                window.active && styles.tmuxWindowButtonActive,
                actionDisabled && styles.disabledButton,
              ]}
              disabled={actionDisabled}
              onPress={() =>
                onAction(`Win ${window.index}`, Methods.TMUX_SELECT_WINDOW, {
                  index: window.index,
                })
              }
            >
              <Text
                style={[
                  styles.controlButtonText,
                  window.active && styles.tmuxWindowButtonTextActive,
                ]}
                numberOfLines={1}
              >
                {activeAction === `Win ${window.index}`
                  ? '…'
                  : `${window.index}:${window.name || 'window'}${
                      window.panes.length > 1 ? `/${window.panes.length}` : ''
                    }`}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}
