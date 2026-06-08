import { useRouter } from 'expo-router';
import { Image, Pressable, ScrollView, Text, View } from 'react-native';

import {
  type PendingDecision,
  type RecipeRunArtifactGroup,
  type Run,
  type RunDecision,
  type TaskProgressStructured,
} from '@farmslot/protocol';

import { BeforeAfterPreview } from '../../../components/BeforeAfterPreview';
import {
  type ArtifactManifestEntry,
  artifactsForRecipeRun,
  artifactSource,
  artifactUrlForEntry,
  classifyArtifact,
  CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
  DECISION_EVIDENCE_RECIPE_RUN_PARAM,
  extractRunArtifactManifest,
  groupVisualArtifactPairs,
  type VisualArtifactPair,
} from '../../../lib/artifact-url';
import { type DecisionPresentation } from '../../../lib/decision-presentation';
import { diffArtifactCandidate } from '../../../lib/diff';
import {
  fallbackTaskProgressSummary,
  taskProgressPercent,
  taskProgressTitle,
} from '../../../lib/task-progress';
import { baseStyles } from '../../../lib/theme';
import {
  artifactFilterParamForArtifactPath,
  artifactFilterParamForWorkspaceNav,
  decisionWorkspaceRouteParams,
  familySectionRouteContextParams,
  recipeWorkspaceParam,
  recipeWorkspaceScopeLabel,
  shouldPreserveArtifactForRecipeContext,
  targetWorkspaceRouteContextParams,
  workspaceSignalTargetForDecisionLabel,
} from '../../../lib/workspace-navigation';
import { decisionWorkspaceStyles as styles } from '../styles/decision-workspace.styles';

export type DecisionDetail = PendingDecision & {
  resolvedAction?: string;
  resolvedAt?: string;
};

export function routeParamString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}
export function DecisionFocusedArtifactCard({
  artifactPath,
  runId,
  slotId,
  familyId,
  prNumber,
  recipeAvailable,
  recipeRunId,
  contextLabel,
  comparePairCount,
  onOpenArtifact,
  onOpenRecipe,
  onOpenDiff,
  onOpenCompare,
  onOpenRun,
  onOpenSlot,
  onOpenTerminal,
  onOpenFamily,
  onOpenPR,
}: {
  artifactPath: string;
  runId?: string | null;
  slotId?: string | null;
  familyId?: string | null;
  prNumber?: number | null;
  recipeAvailable?: boolean;
  recipeRunId?: string | null;
  contextLabel: string;
  comparePairCount: number;
  onOpenArtifact: () => void;
  onOpenRecipe: () => void;
  onOpenDiff: () => void;
  onOpenCompare: () => void;
  onOpenRun: () => void;
  onOpenSlot: () => void;
  onOpenTerminal: () => void;
  onOpenFamily: () => void;
  onOpenPR: () => void;
}) {
  const artifactFilter = artifactFilterParamForArtifactPath(artifactPath);
  const isDiff = Boolean(diffArtifactCandidate([{ path: artifactPath }]));
  const artifactKind =
    artifactFilter === 'recipes'
      ? 'recipe file'
      : artifactFilter === 'visual'
        ? 'visual evidence'
        : isDiff
          ? 'diff'
          : 'evidence file';
  const recipeValue =
    recipeRunId && recipeRunId !== DECISION_EVIDENCE_RECIPE_RUN_PARAM ? 'selected' : 'current';
  return (
    <View style={styles.focusedArtifactCard}>
      <View style={styles.focusedArtifactHeader}>
        <View style={styles.focusedArtifactTitleBlock}>
          <Text style={styles.focusedArtifactEyebrow}>Focused artifact</Text>
          <Text style={styles.focusedArtifactPath} numberOfLines={2}>
            {artifactPath}
          </Text>
          <Text style={styles.focusedArtifactMeta} numberOfLines={1}>
            {artifactKind} · {contextLabel}
          </Text>
        </View>
        <DecisionCockpitAction
          label={isDiff ? 'Open diff' : 'Open'}
          onPress={isDiff ? onOpenDiff : onOpenArtifact}
          primary
        />
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.focusedArtifactActions}
      >
        <DecisionCockpitTile label="Files" value="context" onPress={onOpenArtifact} />
        <DecisionCockpitTile
          label="Recipe files"
          value={recipeAvailable === false ? '-' : recipeValue}
          onPress={onOpenRecipe}
          disabled={!runId || recipeAvailable === false}
        />
        <DecisionCockpitTile
          label="Before→After"
          value={comparePairCount > 0 ? String(comparePairCount) : '-'}
          onPress={onOpenCompare}
          disabled={!runId || comparePairCount === 0}
        />
        <DecisionCockpitTile
          label="Diff"
          value={isDiff ? 'focused' : 'run'}
          onPress={onOpenDiff}
          disabled={!runId}
        />
        <DecisionCockpitTile
          label="Run"
          value={runId ? shortId(runId) : '-'}
          onPress={onOpenRun}
          disabled={!runId}
        />
        <DecisionCockpitTile
          label="Slot"
          value={slotId ? 'workspace' : '-'}
          onPress={onOpenSlot}
          disabled={!slotId}
        />
        <DecisionCockpitTile
          label="Terminal"
          value={slotId ? 'live' : '-'}
          onPress={onOpenTerminal}
          disabled={!slotId}
        />
        <DecisionCockpitTile
          label="Family"
          value={familyId ? shortId(familyId) : '-'}
          onPress={onOpenFamily}
          disabled={!familyId}
        />
        <DecisionCockpitTile
          label="PR"
          value={prNumber ? `#${prNumber}` : '-'}
          onPress={onOpenPR}
          disabled={!prNumber}
        />
      </ScrollView>
    </View>
  );
}
export function DecisionBeforeAfterPriorityPanel({
  pair,
  pairCount,
  kindLabel,
  recipeFallback,
  authHeaders,
  artifactCount,
  recipeArtifactCount,
  recipeAvailable,
  diffValue,
  slotId,
  familyId,
  prNumber,
  onOpenArtifact,
  onOpenCompare,
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
  kindLabel: string;
  recipeFallback: boolean;
  authHeaders: Record<string, string>;
  artifactCount: number;
  recipeArtifactCount: number | null;
  recipeAvailable?: boolean;
  diffValue: string;
  slotId?: string | null;
  familyId?: string | null;
  prNumber?: number | null;
  onOpenArtifact: (artifactPath: string) => void;
  onOpenCompare: () => void;
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
        eyebrow={recipeFallback ? 'Recipe evidence' : 'Review first'}
        title={recipeFallback ? 'Recipe before → after' : `${kindLabel} before → after`}
        hint={`${pairCount} pair${pairCount === 1 ? '' : 's'}`}
        imageHeight={90}
      />
      <View style={styles.beforeAfterPriorityActions}>
        <Text style={styles.beforeAfterPriorityCopy}>
          {recipeFallback
            ? 'Recipe evidence has the clearest visible delta for this gate.'
            : 'Compare the visible delta before using the decision actions.'}
        </Text>
        <Pressable style={styles.beforeAfterPriorityButton} onPress={onOpenCompare}>
          <Text style={styles.beforeAfterPriorityButtonText}>Compare evidence</Text>
        </Pressable>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.beforeAfterPriorityRail}
      >
        <DecisionCockpitTile
          label="Evidence"
          value={String(artifactCount)}
          onPress={onOpenEvidence}
        />
        <DecisionCockpitTile
          label="Recipe"
          value={
            recipeArtifactCount === null
              ? 'loading'
              : recipeAvailable
                ? String(recipeArtifactCount)
                : '-'
          }
          onPress={onOpenRecipe}
          disabled={recipeAvailable === false}
        />
        <DecisionCockpitTile label="Diff" value={diffValue} onPress={onOpenDiff} />
        <DecisionCockpitTile label="Run" value="detail" onPress={onOpenRun} />
        <DecisionCockpitTile
          label="Family"
          value={familyId ? shortId(familyId) : '-'}
          onPress={onOpenFamily}
          disabled={!familyId}
        />
        <DecisionCockpitTile
          label="Terminal"
          value={slotId ? 'live' : '-'}
          onPress={onOpenTerminal}
          disabled={!slotId}
        />
        <DecisionCockpitTile
          label="PR"
          value={prNumber ? `#${prNumber}` : '-'}
          onPress={onOpenPR}
          disabled={!prNumber}
        />
      </ScrollView>
    </View>
  );
}
export function DecisionWorkspaceCockpit({
  presentation,
  currentDecisionId,
  readyDecisionId,
  reviewDecisionId,
  retroDecisionId,
  diffPath,
  recipeArtifactCount,
  recipeAvailable,
  diffAvailable,
  visualPairCount,
  compareArtifactPath,
  compareRecipeRunId,
  focusedArtifactPath,
  workspaceRecipeRunId,
  activeTaskProgress,
  fallbackTaskProgress,
  sourceRun,
  decisionRouteContext,
  onJumpSignals,
  onJumpEvidence,
  onJumpReports,
  onJumpProgress,
  onJumpTerminal,
  onJumpActions,
}: {
  presentation: DecisionPresentation;
  currentDecisionId: string;
  readyDecisionId: string | null;
  reviewDecisionId: string | null;
  retroDecisionId: string | null;
  diffPath?: string;
  recipeArtifactCount: number | null;
  recipeAvailable?: boolean;
  diffAvailable: boolean;
  visualPairCount: number;
  compareArtifactPath: string | null;
  compareRecipeRunId: string;
  focusedArtifactPath: string | null;
  workspaceRecipeRunId: string;
  activeTaskProgress: TaskProgressStructured | null;
  fallbackTaskProgress: ReturnType<typeof fallbackTaskProgressSummary> | null;
  sourceRun: Run | null;
  decisionRouteContext: ReturnType<typeof decisionWorkspaceRouteParams>;
  onJumpSignals: () => void;
  onJumpEvidence: () => void;
  onJumpReports: () => void;
  onJumpProgress: () => void;
  onJumpTerminal: () => void;
  onJumpActions: () => void;
}) {
  const router = useRouter();
  if (!presentation.runId) return null;
  const diffRouteContext = targetWorkspaceRouteContextParams(
    'diff',
    decisionRouteContext.decisionKind,
  );
  const diffValue = presentation.diffStat
    ? `+${presentation.diffStat.additions} -${presentation.diffStat.deletions}`
    : diffPath
      ? 'artifact'
      : diffAvailable
        ? 'workspace'
        : presentation.slotId
          ? 'slot'
          : 'none';
  const hasTerminal = Boolean(presentation.terminalSlotId);
  const progressValue = activeTaskProgress
    ? `${Math.round(taskProgressPercent(activeTaskProgress))}%`
    : fallbackTaskProgress?.percent != null
      ? `${Math.round(fallbackTaskProgress.percent)}%`
      : fallbackTaskProgress
        ? 'live'
        : '-';
  const progressMeta =
    activeTaskProgress && sourceRun
      ? taskProgressTitle(sourceRun, activeTaskProgress)
      : fallbackTaskProgress
        ? fallbackTaskProgress.meta
        : 'No progress';
  const recipeScopeLabel = recipeWorkspaceScopeLabel(workspaceRecipeRunId);
  const evidenceHint = `${visualPairCount} pair${visualPairCount === 1 ? '' : 's'} · ${diffValue}`;
  const gateHint = `${presentation.artifactManifest.length} file${
    presentation.artifactManifest.length === 1 ? '' : 's'
  } · ${diffValue}`;
  const openDecisionArtifacts = () =>
    router.push({
      pathname: '/artifacts/[runId]',
      params: {
        runId: presentation.runId!,
        ...decisionRouteContext,
        recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
        filter: artifactFilterParamForWorkspaceNav('review'),
        ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
      },
    });
  const openCompareArtifacts = () =>
    router.push({
      pathname: '/artifacts/[runId]',
      params: {
        runId: presentation.runId!,
        ...decisionRouteContext,
        recipeRun: compareRecipeRunId,
        filter: artifactFilterParamForWorkspaceNav('compare'),
        ...(compareArtifactPath ? { artifact: compareArtifactPath } : {}),
      },
    });
  const openRecipeArtifacts = () => {
    if (recipeAvailable === false) return;
    const recipeTarget = recipeWorkspaceParam(workspaceRecipeRunId);
    router.push({
      pathname: '/artifacts/[runId]',
      params: {
        runId: presentation.runId!,
        ...decisionRouteContext,
        recipeRun: recipeTarget,
        filter: artifactFilterParamForWorkspaceNav('recipe'),
        ...(shouldPreserveArtifactForRecipeContext(recipeTarget, focusedArtifactPath)
          ? { artifact: focusedArtifactPath }
          : {}),
      },
    });
  };
  const focusedArtifactIsDiff = Boolean(
    focusedArtifactPath && diffArtifactCandidate([{ path: focusedArtifactPath }]),
  );
  const openDiff = () => {
    if (!diffAvailable && presentation.slotId) {
      router.push({
        pathname: '/diff/slot/[slotId]',
        params: { slotId: presentation.slotId, ...diffRouteContext },
      });
      return;
    }
    router.push({
      pathname: '/diff/[runId]',
      params: {
        runId: presentation.runId!,
        ...diffRouteContext,
        ...(focusedArtifactIsDiff && focusedArtifactPath
          ? { path: focusedArtifactPath }
          : diffPath
            ? { path: diffPath }
            : {}),
        recipeRun: workspaceRecipeRunId,
      },
    });
  };
  const openSlot = () => {
    if (!presentation.slotId) return;
    router.push({
      pathname: '/slot/[id]',
      params: {
        id: presentation.slotId,
        ...decisionRouteContext,
        runId: presentation.runId!,
        recipeRun: workspaceRecipeRunId,
        ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
      },
    });
  };
  const openPR = () => {
    if (!presentation.prNumber) return;
    router.push({
      pathname: '/(tabs)/prs',
      params: {
        pr: String(presentation.prNumber),
        ...decisionRouteContext,
        ...(presentation.repo ? { repo: presentation.repo } : {}),
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
        runId: presentation.runId!,
        recipeRun: workspaceRecipeRunId,
        ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
      },
    });
  };
  return (
    <View style={styles.workspaceCockpitPanel}>
      <View style={styles.workspaceCockpitHeader}>
        <View style={styles.workspaceCockpitTitleBlock}>
          <Text style={styles.workspaceCockpitTitle}>
            {presentation.kind === 'retrospective'
              ? 'Retro cockpit'
              : presentation.kind === 'ready'
                ? 'Ready cockpit'
                : 'Review cockpit'}
          </Text>
          <Text style={styles.workspaceCockpitMeta} numberOfLines={1}>
            {presentation.ticketOrPr ?? presentation.runId} · {presentation.kindLabel}
          </Text>
        </View>
        <DecisionCockpitAction
          label="Terminal"
          onPress={() => {
            if (!presentation.terminalSlotId) return;
            router.push({
              pathname: '/terminal/[slotId]',
              params: {
                slotId: presentation.terminalSlotId,
                ...decisionRouteContext,
                runId: presentation.runId!,
                details: '1',
                recipeRun: workspaceRecipeRunId,
                ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
              },
            });
          }}
          disabled={!hasTerminal}
          primary
        />
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.workspaceCockpitRail}
      >
        <DecisionCockpitTile
          label="Signals"
          value={String(presentation.highlights.length)}
          hint={presentation.kindLabel}
          onPress={onJumpSignals}
          disabled={presentation.highlights.length === 0}
        />
        <DecisionCockpitTile
          label="Evidence section"
          value={String(presentation.artifactManifest.length)}
          hint={evidenceHint}
          onPress={onJumpEvidence}
          disabled={presentation.artifactManifest.length === 0}
        />
        <DecisionCockpitTile
          label="Ready gate"
          value={
            readyDecisionId ? (readyDecisionId === currentDecisionId ? 'current' : 'open') : '-'
          }
          hint={readyDecisionId ? gateHint : undefined}
          onPress={() => openDecision(readyDecisionId)}
          disabled={!readyDecisionId || readyDecisionId === currentDecisionId}
        />
        <DecisionCockpitTile
          label="Review gate"
          value={
            reviewDecisionId ? (reviewDecisionId === currentDecisionId ? 'current' : 'open') : '-'
          }
          hint={reviewDecisionId ? gateHint : undefined}
          onPress={() => openDecision(reviewDecisionId)}
          disabled={!reviewDecisionId || reviewDecisionId === currentDecisionId}
        />
        <DecisionCockpitTile
          label="Retro gate"
          value={
            retroDecisionId ? (retroDecisionId === currentDecisionId ? 'current' : 'open') : '-'
          }
          hint={retroDecisionId ? gateHint : undefined}
          onPress={() => openDecision(retroDecisionId)}
          disabled={!retroDecisionId || retroDecisionId === currentDecisionId}
        />
        <DecisionCockpitTile
          label="PR"
          value={presentation.prNumber ? `#${presentation.prNumber}` : '-'}
          onPress={openPR}
          disabled={!presentation.prNumber}
        />
        <DecisionCockpitTile
          label="Slot"
          value={presentation.slotId ?? '-'}
          onPress={openSlot}
          disabled={!presentation.slotId}
        />
        <DecisionCockpitTile
          label="Progress"
          value={progressValue}
          onPress={onJumpProgress}
          disabled={!activeTaskProgress && !fallbackTaskProgress}
          hint={progressMeta}
        />
        <DecisionCockpitTile
          label="Before→After"
          value={String(visualPairCount)}
          hint={diffValue}
          onPress={openCompareArtifacts}
          disabled={visualPairCount === 0}
        />
        <DecisionCockpitTile
          label="Diff view"
          value={diffValue}
          onPress={openDiff}
          disabled={!diffAvailable && !presentation.slotId}
        />
        <DecisionCockpitTile
          label="Report section"
          value={String(presentation.textSections.length)}
          onPress={onJumpReports}
          disabled={presentation.textSections.length === 0}
        />
        <DecisionCockpitTile
          label="Action section"
          value={String(presentation.actions.length)}
          onPress={onJumpActions}
          disabled={presentation.actions.length === 0}
        />
        <DecisionCockpitTile
          label="Artifact files"
          value={String(presentation.artifactManifest.length)}
          onPress={openDecisionArtifacts}
        />
        <DecisionCockpitTile
          label="Recipe files"
          value={
            recipeArtifactCount === null
              ? 'loading'
              : recipeAvailable
                ? String(recipeArtifactCount)
                : '-'
          }
          hint={recipeAvailable ? `${recipeScopeLabel} recipe scope` : undefined}
          onPress={openRecipeArtifacts}
          disabled={recipeAvailable === false}
        />
        <DecisionCockpitTile
          label="Terminal section"
          value={hasTerminal ? 'ready' : '-'}
          onPress={onJumpTerminal}
          disabled={!hasTerminal}
        />
        <DecisionCockpitTile
          label="Family"
          value={presentation.familyId ? shortId(presentation.familyId) : '-'}
          onPress={() =>
            router.push({
              pathname: '/family/[familyId]',
              params: {
                familyId: presentation.familyId!,
                ...((sourceRun?.project ?? presentation.project)
                  ? { project: sourceRun?.project ?? presentation.project }
                  : {}),
                ...familySectionRouteContextParams(
                  presentation.kind === 'retrospective' ? 'retros' : 'focus',
                  decisionRouteContext.decisionKind,
                ),
                runId: presentation.runId!,
                recipeRun: workspaceRecipeRunId,
                ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
                section: presentation.kind === 'retrospective' ? 'retros' : 'focus',
              },
            })
          }
          disabled={!presentation.familyId}
        />
        <DecisionCockpitTile
          label="Run"
          value={shortId(presentation.runId)}
          onPress={() =>
            router.push({
              pathname: '/run/[id]',
              params: {
                id: presentation.runId!,
                ...decisionRouteContext,
                recipeRun: workspaceRecipeRunId,
                ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
              },
            })
          }
        />
      </ScrollView>
    </View>
  );
}
export function DecisionRecipeEvidenceSection({
  runId,
  recipeArtifactCount,
  recipeAvailable,
  previewArtifacts,
  primaryPair,
  authHeaders,
  gatewayUrl,
  onOpenRecipeArtifacts,
  onOpenRecipeArtifact,
}: {
  runId: string;
  recipeArtifactCount: number | null;
  recipeAvailable?: boolean;
  previewArtifacts: ArtifactManifestEntry[];
  primaryPair: VisualArtifactPair | null;
  authHeaders: Record<string, string>;
  gatewayUrl: string;
  onOpenRecipeArtifacts: () => void;
  onOpenRecipeArtifact: (
    artifactPath: string,
    recipeRunId: string,
    filter?: ReturnType<typeof artifactFilterParamForWorkspaceNav>,
  ) => void;
}) {
  const recipeCountLabel =
    recipeArtifactCount === null ? 'loading' : recipeAvailable ? String(recipeArtifactCount) : '-';
  return (
    <View style={styles.section}>
      <View style={styles.recipeEvidenceHeader}>
        <View style={styles.recipeEvidenceTitleBlock}>
          <Text style={styles.sectionTitle}>Recipe evidence</Text>
          <Text style={styles.recipeEvidenceMeta}>
            {recipeCountLabel} recipe artifact{recipeArtifactCount === 1 ? '' : 's'} available from
            this gate.
          </Text>
        </View>
        <Pressable style={styles.recipeEvidenceOpenButton} onPress={onOpenRecipeArtifacts}>
          <Text style={styles.recipeEvidenceOpenText}>Recipe files</Text>
        </Pressable>
      </View>
      {primaryPair ? (
        <View style={styles.recipePairPreview}>
          <BeforeAfterPreview
            pair={primaryPair}
            authHeaders={authHeaders}
            onOpenArtifact={(artifactPath) => {
              const target = [primaryPair.before, primaryPair.after].find(
                (artifact) => artifact.path === artifactPath,
              );
              onOpenRecipeArtifact(
                artifactPath,
                target?.recipeRunId ?? CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
                artifactFilterParamForWorkspaceNav('compare'),
              );
            }}
            eyebrow="Recipe evidence"
            title="Recipe before → after"
            hint="Tap side"
            imageHeight={72}
          />
        </View>
      ) : null}
      {previewArtifacts.length > 0 ? (
        <View style={styles.recipePreviewStrip}>
          {previewArtifacts.map((artifact) => {
            const mediaType = classifyArtifact(artifact);
            const recipeRunId = artifact.recipeRunId ?? CURRENT_ARTIFACTS_RECIPE_RUN_PARAM;
            const isDiffArtifact = diffArtifactCandidate([artifact])?.path === artifact.path;
            return (
              <Pressable
                key={`${recipeRunId}:${artifact.path}`}
                style={styles.recipePreviewTile}
                onPress={() =>
                  onOpenRecipeArtifact(
                    artifact.path,
                    recipeRunId,
                    isDiffArtifact
                      ? artifactFilterParamForWorkspaceNav('compare')
                      : artifactFilterParamForWorkspaceNav('recipe'),
                  )
                }
              >
                {mediaType === 'image' ? (
                  <Image
                    source={artifactSource(
                      artifactUrlForEntry(gatewayUrl, runId, artifact),
                      authHeaders,
                    )}
                    style={styles.recipePreviewImage}
                    resizeMode="cover"
                  />
                ) : (
                  <View style={styles.recipePreviewDocument}>
                    <Text style={styles.recipePreviewKind}>
                      {isDiffArtifact ? 'DIFF' : mediaType.toUpperCase()}
                    </Text>
                  </View>
                )}
                <Text style={styles.recipePreviewPath} numberOfLines={1}>
                  {artifact.path.split('/').pop() ?? artifact.path}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : (
        <Text style={baseStyles.textMuted}>
          Recipe runs are present, but no previewable recipe artifacts were found.
        </Text>
      )}
    </View>
  );
}
export function DecisionCockpitTile({
  label,
  value,
  onPress,
  disabled,
  hint,
}: {
  label: string;
  value: string;
  onPress: () => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <Pressable
      style={[styles.workspaceCockpitTile, disabled && styles.workspaceCockpitDisabled]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={styles.workspaceCockpitTileLabel}>{label}</Text>
      <Text style={styles.workspaceCockpitTileValue} numberOfLines={1}>
        {value}
      </Text>
      {hint ? (
        <Text style={styles.workspaceCockpitTileHint} numberOfLines={1}>
          {hint}
        </Text>
      ) : null}
    </Pressable>
  );
}
export function DecisionCockpitAction({
  label,
  onPress,
  disabled,
  primary,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <Pressable
      style={[
        styles.workspaceCockpitAction,
        primary && styles.workspaceCockpitActionPrimary,
        disabled && styles.workspaceCockpitDisabled,
      ]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text
        style={[
          styles.workspaceCockpitActionText,
          primary && styles.workspaceCockpitActionTextPrimary,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}
export function decisionDetailFromRun(run: Run, decision: RunDecision): DecisionDetail {
  return {
    ...decision,
    slotId: run.slotId,
    context: {
      ...decision.context,
      runId: run.id,
      familyId: run.familyId,
      ticketOrPr: run.ticketOrPr,
      slotId: run.slotId,
      artifactManifest: extractRunArtifactManifest(run),
    },
    runMeta: {
      runId: run.id,
      familyId: run.familyId,
      flowType: run.flowType,
      ticketOrPr: run.ticketOrPr,
      ...(run.prNumber ? { prNumber: run.prNumber } : {}),
      ...(run.branch ? { branch: run.branch } : {}),
      ...(run.metrics?.runner ? { runner: run.metrics.runner } : {}),
      ...(run.metrics?.model ? { model: run.metrics.model } : {}),
      ...(run.summary ? { summary: run.summary } : {}),
    },
  };
}
export function Meta({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metaItem}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}
export function groupArtifacts(
  manifest: ArtifactManifestEntry[],
  gatewayUrl: string,
  runId: string | null,
): VisualArtifactPair[] {
  if (!runId) return [];
  return groupVisualArtifactPairs(manifest, (artifact) =>
    artifactUrlForEntry(gatewayUrl, runId, artifact),
  ).pairs;
}
export function recipeRunIdForVisualPair(
  recipeRuns: RecipeRunArtifactGroup[],
  pair: VisualArtifactPair | null,
): string {
  if (!pair) return recipeRuns[0]?.id ?? CURRENT_ARTIFACTS_RECIPE_RUN_PARAM;
  const directRecipeRunId = pair.after.recipeRunId ?? pair.before.recipeRunId;
  if (directRecipeRunId) return directRecipeRunId;
  const sourceGroup = recipeRuns.find((group) => {
    const artifacts = artifactsForRecipeRun(group);
    return artifacts.some(
      (artifact) => artifact.path === pair.before.path || artifact.path === pair.after.path,
    );
  });
  return sourceGroup?.id ?? recipeRuns[0]?.id ?? CURRENT_ARTIFACTS_RECIPE_RUN_PARAM;
}
export function signalTarget(
  label: string,
  runId: string | null,
  diffPath?: string,
  compareArtifactPath?: string,
  compareRecipeRunId = DECISION_EVIDENCE_RECIPE_RUN_PARAM,
  decisionRouteContext: ReturnType<typeof decisionWorkspaceRouteParams> = {},
) {
  if (!runId) return null;
  const target = workspaceSignalTargetForDecisionLabel(label);
  if (target === 'diff') {
    return {
      pathname: '/diff/[runId]' as const,
      params: {
        runId,
        ...targetWorkspaceRouteContextParams('diff', decisionRouteContext.decisionKind),
        path: diffPath ?? '',
        recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
      },
    };
  }
  if (target === 'artifacts' || target === 'compare') {
    return {
      pathname: '/artifacts/[runId]' as const,
      params: {
        runId,
        ...decisionRouteContext,
        recipeRun: target === 'compare' ? compareRecipeRunId : DECISION_EVIDENCE_RECIPE_RUN_PARAM,
        filter:
          target === 'compare'
            ? artifactFilterParamForWorkspaceNav('compare')
            : artifactFilterParamForWorkspaceNav('review'),
        ...(target === 'compare' && compareArtifactPath ? { artifact: compareArtifactPath } : {}),
      },
    };
  }
  return null;
}
export function shortId(value: string | null | undefined): string {
  if (!value) return '-';
  return value.length <= 10 ? value : `${value.slice(0, 8)}…`;
}
