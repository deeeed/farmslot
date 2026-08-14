import type React from 'react';
import { Image, Pressable, ScrollView, Text, View } from 'react-native';

import {
  buildFamilyIterationLedgerPresentation,
  type FamilyChangeLedgerEntry,
  FamilyObservabilityArtifact,
  FamilyObservabilityRunSummary,
  FamilyObservabilitySnapshot,
  RecipeRunArtifactGroup,
  RetrospectivePayload,
  Run,
  RunDecision,
  TaskProgressStructured,
} from '@farmslot/protocol';

import { ArtifactCard, ComparisonCard } from '../../../components/ArtifactCard';
import { BeforeAfterPreview } from '../../../components/BeforeAfterPreview';
import {
  TaskProgressFallbackPanel,
  TaskProgressPanel,
} from '../../../components/TaskProgressPanel';
import {
  type ArtifactManifestEntry,
  artifactsForRecipeRun,
  artifactUrl,
  artifactUrlForEntry,
  classifyArtifact,
  CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
  DECISION_EVIDENCE_RECIPE_RUN_PARAM,
  groupVisualArtifactPairs,
  type VisualArtifactPair,
} from '../../../lib/artifact-url';
import { type DecisionPresentation, presentDecision } from '../../../lib/decision-presentation';
import { diffArtifactCandidate } from '../../../lib/diff';
import {
  familyArtifactKind,
  type FamilyEvidenceGroup,
  familyEvidenceKindLabel,
  familyRunBadgeLabel,
  MAX_ARTIFACTS_PER_FAMILY_EVIDENCE_GROUP,
} from '../../../lib/family-evidence';
import {
  selectSlotCompareTarget,
  selectSlotRecipeArtifactsForPreviewScope,
} from '../../../lib/slot-workspace';
import { type fallbackTaskProgressSummary, taskProgressPercent } from '../../../lib/task-progress';
import { baseStyles, colors } from '../../../lib/theme';
import {
  selectReadyWorkspaceDecision,
  selectRetrospectiveWorkspaceDecision,
  selectReviewGateWorkspaceDecision,
} from '../../../lib/workspace-decisions';
import {
  artifactFilterParamForArtifactPath,
  artifactFilterParamForWorkspaceNav,
  recipeWorkspaceScopeLabel,
  workspaceSignalTargetForDecisionLabel,
} from '../../../lib/workspace-navigation';
import { shortId } from '../../workspace-shared/format';
import {
  type FamilyRecipeEvidenceSummary,
  STATUS_COLORS,
  TONE_COLORS,
} from '../family-workspace-model';
import { familyWorkspaceStyles as styles } from '../styles/family-workspace.styles';

export function familyArtifactUrl(
  gatewayUrl: string,
  artifact: FamilyObservabilityArtifact,
): string {
  return artifactUrl(gatewayUrl, artifact.runId, artifact.path);
}

export function summarizeFamilyRecipeEvidence(
  recipeRuns: RecipeRunArtifactGroup[],
  gatewayUrl: string,
  runId: string,
): FamilyRecipeEvidenceSummary {
  const compareTarget = selectSlotCompareTarget({
    runArtifacts: [],
    recipeRuns,
    selectedRecipeRunId: null,
  });
  const recipeVisualPairSummary = groupVisualArtifactPairs(
    selectSlotRecipeArtifactsForPreviewScope(recipeRuns, null),
    (artifact) => artifactUrlForEntry(gatewayUrl, runId, artifact),
  );
  const primaryPair = recipeVisualPairSummary.pairs[0] ?? null;
  return {
    artifactCount: recipeRuns.reduce(
      (count, group) => count + artifactsForRecipeRun(group).length,
      0,
    ),
    pairCount: compareTarget?.pairCount ?? recipeVisualPairSummary.pairs.length,
    recipeRunId:
      compareTarget?.recipeRunId ??
      (primaryPair ? recipeRunIdForVisualPair(recipeRuns, primaryPair) : null),
    artifactPath: compareTarget?.artifactPath ?? primaryPair?.after.path ?? null,
    primaryPair,
  };
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

export function FamilyWorkspaceCockpit({
  selectedRun,
  readyDecisionId,
  reviewDecisionId,
  retroDecisionId,
  evidenceCount,
  visualPairCount,
  ledgerEntryCount,
  retrospectiveCount,
  pendingRetrospectiveCount,
  recipeArtifactCount,
  recipeAvailable,
  recipeScopeLabel,
  diffValue,
  onJumpFocus,
  onJumpCompare,
  onJumpLedger,
  onJumpRetros,
  onJumpEvidence,
  onJumpRuns,
  onOpenRun,
  onOpenArtifacts,
  onOpenRecipe,
  onOpenDiff,
  onOpenSlot,
  onOpenPR,
  onOpenTerminal,
  onOpenDecision,
}: {
  selectedRun: FamilyObservabilityRunSummary | null;
  readyDecisionId: string | null;
  reviewDecisionId: string | null;
  retroDecisionId: string | null;
  evidenceCount: number;
  visualPairCount: number;
  ledgerEntryCount: number;
  retrospectiveCount: number;
  pendingRetrospectiveCount: number;
  recipeArtifactCount: number | null;
  recipeAvailable?: boolean;
  recipeScopeLabel: ReturnType<typeof recipeWorkspaceScopeLabel>;
  diffValue: string;
  onJumpFocus: () => void;
  onJumpCompare: () => void;
  onJumpLedger: () => void;
  onJumpRetros: () => void;
  onJumpEvidence: () => void;
  onJumpRuns: () => void;
  onOpenRun: () => void;
  onOpenArtifacts: () => void;
  onOpenRecipe: () => void;
  onOpenDiff: () => void;
  onOpenSlot: () => void;
  onOpenPR: () => void;
  onOpenTerminal: () => void;
  onOpenDecision: (decisionId: string) => void;
}) {
  return (
    <View style={styles.familyCockpit}>
      <View style={styles.familyCockpitHeader}>
        <View style={styles.familyCockpitTitleBlock}>
          <Text style={styles.familyCockpitTitle}>Family cockpit</Text>
          <Text style={styles.familyCockpitMeta} numberOfLines={1}>
            {selectedRun?.ticketOrPr ?? 'No selected run'}
          </Text>
        </View>
        <FamilyCockpitAction
          label="Terminal"
          onPress={onOpenTerminal}
          disabled={!selectedRun?.slotId}
          primary
        />
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.familyCockpitRail}
      >
        <FamilyCockpitTile label="Focus" value={selectedRun?.status ?? '-'} onPress={onJumpFocus} />
        <FamilyCockpitTile
          label="Run"
          value={selectedRun ? shortId(selectedRun.runId) : '-'}
          hint={selectedRun?.flowType}
          onPress={onOpenRun}
          disabled={!selectedRun}
        />
        <FamilyCockpitTile
          label="Ready gate"
          value={readyDecisionId ? shortId(readyDecisionId) : '-'}
          hint={selectedRun ? `${selectedRun.artifacts.length} files · ${diffValue}` : undefined}
          onPress={() => {
            if (readyDecisionId) onOpenDecision(readyDecisionId);
          }}
          disabled={!readyDecisionId}
        />
        <FamilyCockpitTile
          label="Review gate"
          value={reviewDecisionId ? shortId(reviewDecisionId) : '-'}
          hint={selectedRun ? `${selectedRun.artifacts.length} files · ${diffValue}` : undefined}
          onPress={() => {
            if (reviewDecisionId) onOpenDecision(reviewDecisionId);
          }}
          disabled={!reviewDecisionId}
        />
        <FamilyCockpitTile
          label="Retro gate"
          value={retroDecisionId ? shortId(retroDecisionId) : '-'}
          hint={`${pendingRetrospectiveCount} pending · ${retrospectiveCount} total`}
          onPress={() => {
            if (retroDecisionId) onOpenDecision(retroDecisionId);
          }}
          disabled={!retroDecisionId}
        />
        <FamilyCockpitTile
          label="Artifact files"
          value={selectedRun ? String(selectedRun.artifacts.length) : '-'}
          onPress={onOpenArtifacts}
          disabled={!selectedRun}
        />
        <FamilyCockpitTile
          label="Recipe files"
          value={
            recipeArtifactCount === null
              ? 'loading'
              : recipeAvailable
                ? String(recipeArtifactCount)
                : '-'
          }
          hint={recipeAvailable ? `${recipeScopeLabel} recipe scope` : undefined}
          onPress={onOpenRecipe}
          disabled={!selectedRun || recipeAvailable === false}
        />
        <FamilyCockpitTile
          label="PR"
          value={selectedRun?.prNumber ? `#${selectedRun.prNumber}` : '-'}
          onPress={onOpenPR}
          disabled={!selectedRun?.prNumber}
        />
        <FamilyCockpitTile
          label="Slot"
          value={selectedRun?.slotId ?? '-'}
          onPress={onOpenSlot}
          disabled={!selectedRun?.slotId}
        />
        <FamilyCockpitTile
          label="Before→After"
          value={String(visualPairCount)}
          hint={diffValue !== 'none' ? diffValue : undefined}
          onPress={onJumpCompare}
          disabled={visualPairCount === 0}
        />
        <FamilyCockpitTile
          label="Ledger"
          value={String(ledgerEntryCount)}
          onPress={onJumpLedger}
          disabled={ledgerEntryCount === 0}
        />
        <FamilyCockpitTile
          label="Evidence section"
          value={String(evidenceCount)}
          onPress={onJumpEvidence}
        />
        <FamilyCockpitTile
          label="Retro section"
          value={`${pendingRetrospectiveCount}/${retrospectiveCount}`}
          hint="pending / total"
          onPress={onJumpRetros}
        />
        <FamilyCockpitTile
          label="Diff view"
          value={diffValue}
          onPress={onOpenDiff}
          disabled={!selectedRun}
        />
        <FamilyCockpitTile label="Runs" value={selectedRun ? 'family' : '-'} onPress={onJumpRuns} />
      </ScrollView>
    </View>
  );
}

export function FamilyCockpitTile({
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
      style={[styles.familyCockpitTile, disabled && styles.familyCockpitDisabled]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={styles.familyCockpitTileLabel}>{label}</Text>
      <Text style={styles.familyCockpitTileValue} numberOfLines={1}>
        {value}
      </Text>
      {hint ? (
        <Text style={styles.familyCockpitTileHint} numberOfLines={1}>
          {hint}
        </Text>
      ) : null}
    </Pressable>
  );
}

export function FamilyCockpitAction({
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
        styles.familyCockpitAction,
        primary && styles.familyCockpitActionPrimary,
        disabled && styles.familyCockpitDisabled,
      ]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text
        style={[styles.familyCockpitActionText, primary && styles.familyCockpitActionTextPrimary]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function FamilyFocusedArtifactCard({
  artifactPath,
  recipeRunId,
  prNumber,
  onOpenRun,
  onOpenRecipe,
  onOpenArtifact,
  onOpenFiles,
  onOpenDiff,
  comparePairCount,
  onOpenCompare,
  onOpenSlot,
  onOpenTerminal,
  onOpenPR,
  slotAvailable,
}: {
  artifactPath: string;
  recipeRunId: string;
  prNumber?: number | null;
  onOpenRun: () => void;
  onOpenRecipe: () => void;
  onOpenArtifact: () => void;
  onOpenFiles: () => void;
  onOpenDiff: () => void;
  comparePairCount: number;
  onOpenCompare: () => void;
  onOpenSlot: () => void;
  onOpenTerminal: () => void;
  onOpenPR: () => void;
  slotAvailable: boolean;
}) {
  const artifactKind = familyFocusedArtifactKindLabel(artifactPath);
  const isDiff = shouldOpenFamilyFocusedArtifactAsDiff(artifactPath);
  const recipeScoped = recipeRunId !== DECISION_EVIDENCE_RECIPE_RUN_PARAM;
  const recipeScopeLabel = recipeWorkspaceScopeLabel(recipeRunId);
  return (
    <View style={styles.familyFocusedArtifactCard}>
      <View style={styles.familyCockpitHeader}>
        <View style={styles.familyCockpitTitleBlock}>
          <Text style={styles.familyFocusedArtifactEyebrow}>Focused artifact</Text>
          <Text style={styles.familyFocusedArtifactPath} numberOfLines={2}>
            {artifactPath}
          </Text>
          <Text style={styles.familyFocusedArtifactMeta} numberOfLines={1}>
            {artifactKind} · {recipeScoped ? 'recipe context' : 'decision evidence'}
          </Text>
        </View>
        <FamilyCockpitAction
          label={isDiff ? 'Open diff' : 'Open'}
          onPress={isDiff ? onOpenDiff : onOpenArtifact}
          primary
        />
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.familyCockpitRail}
      >
        <FamilyCockpitTile label="Files" value="context" onPress={onOpenFiles} />
        <FamilyCockpitTile label="Recipe files" value={recipeScopeLabel} onPress={onOpenRecipe} />
        <FamilyCockpitTile
          label="Before→After"
          value={comparePairCount > 0 ? String(comparePairCount) : '-'}
          onPress={onOpenCompare}
          disabled={comparePairCount === 0}
        />
        <FamilyCockpitTile label="Diff" value={isDiff ? 'focused' : 'run'} onPress={onOpenDiff} />
        <FamilyCockpitTile label="Run" value="detail" onPress={onOpenRun} />
        <FamilyCockpitTile
          label="Slot"
          value={slotAvailable ? 'workspace' : '-'}
          onPress={onOpenSlot}
          disabled={!slotAvailable}
        />
        <FamilyCockpitTile
          label="Terminal"
          value={slotAvailable ? 'live' : '-'}
          onPress={onOpenTerminal}
          disabled={!slotAvailable}
        />
        <FamilyCockpitTile
          label="PR"
          value={prNumber ? `#${prNumber}` : '-'}
          onPress={onOpenPR}
          disabled={!prNumber}
        />
      </ScrollView>
    </View>
  );
}

export function familyFocusedArtifactKindLabel(artifactPath: string): string {
  if (shouldOpenFamilyFocusedArtifactAsDiff(artifactPath)) return 'diff';
  const filter = artifactFilterParamForArtifactPath(artifactPath);
  if (filter === 'recipes') return 'recipe file';
  if (filter === 'visual') return 'visual evidence';
  return 'evidence file';
}

export function shouldOpenFamilyFocusedArtifactAsDiff(artifactPath: string): boolean {
  return Boolean(diffArtifactCandidate([{ path: artifactPath }]));
}

type FamilyCompareArtifact = ArtifactManifestEntry & { runId?: string } & {
  url: string;
};
type FamilyComparePair = VisualArtifactPair<ArtifactManifestEntry & { runId?: string }>;

export function FamilyBeforeAfterPriorityPanel({
  pair,
  pairCount,
  authHeaders,
  recipeFallback,
  artifactCount,
  recipeArtifactCount,
  recipeAvailable,
  diffValue,
  slotId,
  prNumber,
  onOpenArtifact,
  onOpenCompare,
  onOpenEvidence,
  onOpenRecipe,
  onOpenDiff,
  onOpenRun,
  onOpenRetros,
  onOpenTerminal,
  onOpenPR,
}: {
  pair: VisualArtifactPair;
  pairCount: number;
  authHeaders: Record<string, string>;
  recipeFallback: boolean;
  artifactCount: number;
  recipeArtifactCount: number | null;
  recipeAvailable?: boolean;
  diffValue: string;
  slotId?: string | null;
  prNumber?: number | null;
  onOpenArtifact: (artifactPath: string) => void;
  onOpenCompare: () => void;
  onOpenEvidence: () => void;
  onOpenRecipe: () => void;
  onOpenDiff: () => void;
  onOpenRun: () => void;
  onOpenRetros: () => void;
  onOpenTerminal: () => void;
  onOpenPR: () => void;
}) {
  return (
    <View style={styles.familyBeforeAfterPriorityPanel}>
      <BeforeAfterPreview
        pair={pair}
        authHeaders={authHeaders}
        onOpenArtifact={onOpenArtifact}
        eyebrow={recipeFallback ? 'Recipe evidence' : 'Review first'}
        title={recipeFallback ? 'Recipe before → after' : 'Family before → after evidence'}
        hint={`${pairCount} pair${pairCount === 1 ? '' : 's'}`}
        imageHeight={88}
      />
      <View style={styles.familyBeforeAfterPriorityActions}>
        <Text style={styles.familyBeforeAfterPriorityCopy}>
          {recipeFallback
            ? 'Recipe evidence has the clearest visible delta for the selected family run.'
            : 'Start from the visible delta, then drill into runs, artifacts, retros, or the ledger.'}
        </Text>
        <Pressable style={styles.familyBeforeAfterPriorityButton} onPress={onOpenCompare}>
          <Text style={styles.familyBeforeAfterPriorityButtonText}>Compare evidence</Text>
        </Pressable>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.familyBeforeAfterPriorityRail}
      >
        <FamilyCockpitTile
          label="Evidence"
          value={String(artifactCount)}
          onPress={onOpenEvidence}
        />
        <FamilyCockpitTile
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
        <FamilyCockpitTile label="Diff" value={diffValue} onPress={onOpenDiff} />
        <FamilyCockpitTile label="Run" value="detail" onPress={onOpenRun} />
        <FamilyCockpitTile label="Retros" value="family" onPress={onOpenRetros} />
        <FamilyCockpitTile
          label="Terminal"
          value={slotId ? 'live' : '-'}
          onPress={onOpenTerminal}
          disabled={!slotId}
        />
        <FamilyCockpitTile
          label="PR"
          value={prNumber ? `#${prNumber}` : '-'}
          onPress={onOpenPR}
          disabled={!prNumber}
        />
      </ScrollView>
    </View>
  );
}

export function FamilyComparePanel({
  pairs,
  recipeFallback,
  artifactAuthHeaders,
  onOpenVisual,
  onOpenArtifactWorkspace,
  onOpenArtifacts,
}: {
  pairs: FamilyComparePair[];
  recipeFallback: boolean;
  artifactAuthHeaders: Record<string, string>;
  onOpenVisual: (uri: string) => void;
  onOpenArtifactWorkspace: (artifact: FamilyCompareArtifact) => void;
  onOpenArtifacts: () => void;
}) {
  if (pairs.length === 0) return null;
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <View>
          <Text style={styles.sectionTitle}>
            {recipeFallback ? 'Recipe before → after compare' : 'Before → After compare'}
          </Text>
          <Text style={styles.sectionMeta}>
            {pairs.length} visual difference pair{pairs.length === 1 ? '' : 's'}
            {recipeFallback ? ' · recipe fallback' : ''}
          </Text>
        </View>
        <Pressable style={styles.compactOpenButton} onPress={onOpenArtifacts}>
          <Text style={styles.compactOpenText}>
            {recipeFallback ? 'Recipe compare' : 'Evidence files'}
          </Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        {pairs.slice(0, 6).map((pair) => (
          <View key={`${pair.before.path}:${pair.after.path}`} style={styles.comparePairCard}>
            <ComparisonCard
              pair={pair}
              authHeaders={artifactAuthHeaders}
              onOpenBefore={() => onOpenVisual(pair.before.url)}
              onOpenAfter={() => onOpenVisual(pair.after.url)}
            />
            <View style={styles.comparePairActions}>
              <Pressable
                style={styles.comparePairAction}
                onPress={() => onOpenArtifactWorkspace(pair.before)}
              >
                <Text style={styles.comparePairActionText}>Before artifacts</Text>
              </Pressable>
              <Pressable
                style={styles.comparePairAction}
                onPress={() => onOpenArtifactWorkspace(pair.after)}
              >
                <Text style={styles.comparePairActionText}>After artifacts</Text>
              </Pressable>
            </View>
          </View>
        ))}
      </ScrollView>
      {pairs.length > 6 ? (
        <Text style={styles.compareMoreText}>+{pairs.length - 6} more pairs in artifacts</Text>
      ) : null}
    </View>
  );
}

export function FamilyChangeLedgerPanel({
  snapshot,
  onOpenRun,
  onOpenArtifacts,
  onOpenDiff,
  onOpenSlot,
  onOpenTerminal,
}: {
  snapshot: FamilyObservabilitySnapshot;
  onOpenRun: (runId: string) => void;
  onOpenArtifacts: (runId: string, artifactPath?: string) => void;
  onOpenDiff: (entry: FamilyChangeLedgerEntry, artifactPath?: string) => void;
  onOpenSlot: (slotId: string, runId: string) => void;
  onOpenTerminal: (slotId: string, runId: string) => void;
}) {
  const ledger = snapshot.familyChangeLedger;
  if (!ledger) return null;

  const summary = ledger.summary;
  const missingEntries = ledger.entries.filter((entry) => entry.missingData.length > 0);
  const visibleEntries = ledger.entries.slice(0, 5);
  const iteration = buildFamilyIterationLedgerPresentation(snapshot);
  const runById = new Map(snapshot.runs.map((run) => [run.runId, run]));
  const contributionDelta = snapshot.diffStat.available
    ? `${snapshot.diffStat.files} files · +${snapshot.diffStat.additions} -${snapshot.diffStat.deletions}`
    : `${summary.totalContributionFiles} files · +${summary.totalContributionAdditions} -${summary.totalContributionDeletions}`;

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <View>
          <Text style={styles.sectionTitle}>Change ledger</Text>
          <Text style={styles.sectionMeta}>
            Durable diff, review, and artifact signals from Command Center
          </Text>
        </View>
        <Pressable
          style={styles.compactOpenButton}
          onPress={() => onOpenArtifacts(snapshot.latestRunId)}
        >
          <Text style={styles.compactOpenText}>Evidence files</Text>
        </Pressable>
      </View>
      <View style={styles.ledgerMetricGrid}>
        <Metric label="Iterations" value={String(iteration.summary.totalRuns)} compact />
        <Metric label="Code deltas" value={String(iteration.summary.producedDiffRuns)} compact />
        <Metric
          label="Recipe/evidence"
          value={`${iteration.summary.recipeRuns}/${iteration.summary.evidenceRuns}`}
          compact
        />
        <Metric
          label="Produced diffs"
          value={`${summary.runsWithContributionDiff}/${ledger.entries.length}`}
          compact
        />
        <Metric
          label="Reviewed input"
          value={`${summary.runsWithReviewInputDiff}/${ledger.entries.length}`}
          compact
        />
        <Metric label="Delta" value={contributionDelta} compact />
        <Metric
          label="Artifact data"
          value={`${summary.artifactFootprint.count} · ${formatBytes(
            summary.artifactFootprint.bytes,
          )}`}
          compact
        />
        <Metric label="Bugbots fixed" value={String(summary.bugbotFindingsAddressed)} compact />
        <Metric label="Human fixed" value={String(summary.humanCommentsAddressed)} compact />
        <Metric label="Missing data" value={String(missingEntries.length)} compact />
      </View>
      <View style={styles.iterationTimeline}>
        {iteration.cards.slice(0, 5).map((card) => {
          const entry = ledger.entries.find((candidate) => candidate.runId === card.runId);
          const run = runById.get(card.runId);
          const diffArtifactPath = entry ? primaryLedgerDiffPath(entry) : undefined;
          return (
            <View key={card.runId} style={styles.iterationCard}>
              <View style={styles.iterationIndex}>
                <Text style={styles.iterationIndexText}>{card.index}</Text>
              </View>
              <View style={styles.iterationBody}>
                <View style={styles.iterationHeader}>
                  <Text style={styles.iterationFlow}>{card.flowLabel}</Text>
                  <Text style={styles.iterationRunId}>{card.shortRunId}</Text>
                  <Text style={styles.iterationPr}>{card.prLabel}</Text>
                </View>
                <Text style={styles.iterationReason}>{card.reason}</Text>
                <Text style={styles.iterationTitle} numberOfLines={2}>
                  {card.title}
                </Text>
                <View style={styles.iterationSignalGrid}>
                  <IterationSignal label="Diff" value={card.diffLabel} />
                  <IterationSignal label="Reviewed input" value={card.reviewedInputLabel} />
                  <IterationSignal label="Recipe" value={card.recipeLabel} />
                  <IterationSignal label="Evidence" value={card.evidenceLabel} />
                  <IterationSignal label="Review cause" value={card.reviewLabel} />
                  <IterationSignal
                    label="Ledger"
                    value={card.missingLabel}
                    warn={card.missingLabel !== 'complete'}
                  />
                </View>
                <View style={styles.runActions}>
                  <Pressable style={styles.inlineButton} onPress={() => onOpenRun(card.runId)}>
                    <Text style={styles.inlineButtonText}>Run</Text>
                  </Pressable>
                  <Pressable
                    style={styles.inlineButton}
                    onPress={() => onOpenArtifacts(card.runId)}
                  >
                    <Text style={styles.inlineButtonText}>Evidence</Text>
                  </Pressable>
                  {entry ? (
                    <Pressable
                      style={styles.inlineButton}
                      onPress={() => onOpenDiff(entry, diffArtifactPath)}
                    >
                      <Text style={styles.inlineButtonText}>Diff</Text>
                    </Pressable>
                  ) : null}
                  {run?.slotId ? (
                    <Pressable
                      style={styles.inlineButton}
                      onPress={() => onOpenTerminal(run.slotId!, card.runId)}
                    >
                      <Text style={styles.inlineButtonText}>Terminal</Text>
                    </Pressable>
                  ) : null}
                </View>
              </View>
            </View>
          );
        })}
      </View>
      <View style={styles.ledgerEntries}>
        {visibleEntries.map((entry) => {
          const run = runById.get(entry.runId);
          const diffArtifactPath = primaryLedgerDiffPath(entry);
          return (
            <View key={entry.runId} style={styles.ledgerEntryCard}>
              <View style={styles.ledgerEntryHeader}>
                <View style={styles.ledgerEntryTitleWrap}>
                  <Text style={styles.ledgerEntryTitle} numberOfLines={1}>
                    {entry.ticketOrPr}
                  </Text>
                  <Text style={styles.ledgerEntryMeta} numberOfLines={1}>
                    {entry.flowType} · {entry.changeKind} · {entry.runId.slice(0, 8)}
                  </Text>
                </View>
                <Text style={styles.ledgerEntryPr}>
                  {entry.prNumber ? `#${entry.prNumber}` : entry.lane}
                </Text>
              </View>
              <View style={styles.ledgerEntryFacts}>
                <Text style={styles.ledgerFact}>
                  Diff:{' '}
                  {entry.contributionDiff.available
                    ? `${entry.contributionDiff.files} files · +${entry.contributionDiff.additions} -${entry.contributionDiff.deletions}`
                    : entry.inputDiff?.available
                      ? `${entry.inputDiff.files} reviewed files`
                      : (entry.contributionDiff.missingReason ?? 'none')}
                </Text>
                <Text style={styles.ledgerFact}>
                  Evidence files: {entry.artifactFootprint.count} ·{' '}
                  {formatBytes(entry.artifactFootprint.bytes)}
                </Text>
                {entry.reviewSignals ? (
                  <Text style={styles.ledgerFact}>
                    Review: bot {entry.reviewSignals.botAddressed} · human{' '}
                    {entry.reviewSignals.humanCommentsAddressed}
                  </Text>
                ) : null}
                {entry.missingData.length > 0 ? (
                  <Text style={styles.ledgerMissing} numberOfLines={2}>
                    Missing: {entry.missingData.join(', ')}
                  </Text>
                ) : null}
              </View>
              <View style={styles.runActions}>
                <Pressable style={styles.inlineButton} onPress={() => onOpenRun(entry.runId)}>
                  <Text style={styles.inlineButtonText}>Run detail</Text>
                </Pressable>
                <Pressable style={styles.inlineButton} onPress={() => onOpenArtifacts(entry.runId)}>
                  <Text style={styles.inlineButtonText}>Evidence files</Text>
                </Pressable>
                <Pressable
                  style={styles.inlineButton}
                  onPress={() => onOpenDiff(entry, diffArtifactPath)}
                >
                  <Text style={styles.inlineButtonText}>Diff view</Text>
                </Pressable>
                {run?.slotId ? (
                  <>
                    <Pressable
                      style={styles.inlineButton}
                      onPress={() => onOpenSlot(run.slotId!, entry.runId)}
                    >
                      <Text style={styles.inlineButtonText}>Slot</Text>
                    </Pressable>
                    <Pressable
                      style={styles.inlineButton}
                      onPress={() => onOpenTerminal(run.slotId!, entry.runId)}
                    >
                      <Text style={styles.inlineButtonText}>Terminal</Text>
                    </Pressable>
                  </>
                ) : null}
              </View>
            </View>
          );
        })}
      </View>
      {ledger.entries.length > visibleEntries.length ? (
        <Text style={styles.ledgerMoreText}>
          +{ledger.entries.length - visibleEntries.length} more ledger entr
          {ledger.entries.length - visibleEntries.length === 1 ? 'y' : 'ies'} in this family.
        </Text>
      ) : null}
    </View>
  );
}

function IterationSignal({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <View style={styles.iterationSignal}>
      <Text style={styles.iterationSignalLabel}>{label}</Text>
      <Text
        style={[styles.iterationSignalValue, warn ? styles.iterationSignalValueWarn : null]}
        numberOfLines={2}
      >
        {value}
      </Text>
    </View>
  );
}

export function primaryLedgerDiffPath(entry: FamilyChangeLedgerEntry): string | undefined {
  return (
    entry.contributionDiff.artifactPath ??
    entry.inputDiff?.artifactPath ??
    entry.legacyDiffFallback?.artifactPath
  );
}

export function decisionPresentationForFamilyRun(
  run: FamilyObservabilityRunSummary,
  decision: RunDecision,
): DecisionPresentation {
  return presentDecision({
    ...decision,
    slotId: run.slotId,
    context: {
      ...(decision.context ?? {}),
      runId: run.runId,
      familyId: run.familyId,
      ticketOrPr: run.ticketOrPr,
      ...(run.slotId ? { slotId: run.slotId } : {}),
      artifactManifest: run.artifacts,
    },
    runMeta: {
      runId: run.runId,
      familyId: run.familyId,
      flowType: run.flowType,
      ticketOrPr: run.ticketOrPr,
      branch: run.branch ?? undefined,
      runner: run.metrics?.runner ?? undefined,
      model: run.metrics?.model ?? undefined,
      summary: run.summary ?? undefined,
    },
  });
}

export function RetrospectiveCard({
  run,
  decision,
  recipeEvidence,
  recipeArtifactCount,
  recipeAvailable,
  gatewayUrl,
  artifactAuthHeaders,
  onOpenVisual,
  onOpenDocument,
  onOpenDiffArtifact,
  onOpenDecision,
  onOpenRun,
  onOpenArtifacts,
  onOpenArtifact,
  onOpenRecipe,
  onOpenRecipeCompare,
  onOpenDiff,
  onOpenTerminal,
  onOpenSlot,
  onOpenPR,
}: {
  run: FamilyObservabilityRunSummary;
  decision: RunDecision;
  recipeEvidence: FamilyRecipeEvidenceSummary | null;
  recipeArtifactCount: number | null;
  recipeAvailable?: boolean;
  gatewayUrl: string;
  artifactAuthHeaders: Record<string, string>;
  onOpenVisual: (uri: string) => void;
  onOpenDocument: (artifact: FamilyObservabilityArtifact) => void;
  onOpenDiffArtifact: (artifact: FamilyObservabilityArtifact) => void;
  onOpenDecision: () => void;
  onOpenRun: () => void;
  onOpenArtifacts: () => void;
  onOpenArtifact: (artifactPath: string) => void;
  onOpenRecipe: () => void;
  onOpenRecipeCompare: (artifactPath?: string) => void;
  onOpenDiff: () => void;
  onOpenTerminal: () => void;
  onOpenSlot: () => void;
  onOpenPR: () => void;
}) {
  const payload =
    decision.payload?.kind === 'retrospective' ? (decision.payload as RetrospectivePayload) : null;
  const presentation = decisionPresentationForFamilyRun(run, decision);
  const primaryArtifactPath = presentation.artifactManifest[0]?.path ?? null;
  const openEvidence = primaryArtifactPath
    ? () => onOpenArtifact(primaryArtifactPath)
    : onOpenArtifacts;
  const statusTone = decision.resolvedAt ? colors.statusOk : colors.statusWarn;
  const recipeValue =
    recipeArtifactCount !== null ? String(recipeArtifactCount) : recipeAvailable ? 'yes' : '-';
  const diffValue = run.diffStat.available ? 'files' : run.slotId ? 'workspace' : '-';
  const retroVisualPairSummary = groupVisualArtifactPairs(
    presentation.artifactManifest,
    (artifact) => artifactUrl(gatewayUrl, run.runId, artifact.path),
  );
  const retroPrimaryVisualPair = retroVisualPairSummary.pairs[0] ?? null;
  const recipePairCount = recipeEvidence?.pairCount ?? 0;
  const recipePrimaryVisualPair =
    retroVisualPairSummary.pairs.length === 0 ? (recipeEvidence?.primaryPair ?? null) : null;
  const comparePairCount =
    retroVisualPairSummary.pairs.length > 0 ? retroVisualPairSummary.pairs.length : recipePairCount;
  const openRetroCompare = retroPrimaryVisualPair
    ? () => onOpenArtifact(retroPrimaryVisualPair.after.path)
    : recipePairCount > 0
      ? () => onOpenRecipeCompare()
      : onOpenArtifacts;
  return (
    <Pressable
      style={[
        styles.retroCard,
        { backgroundColor: `${statusTone}14`, borderColor: `${statusTone}55` },
      ]}
      onPress={onOpenDecision}
    >
      <View style={styles.retroHeaderRow}>
        <Text style={[styles.retroRun, { color: statusTone }]}>{run.ticketOrPr}</Text>
        <View style={[styles.retroStatusBadge, { backgroundColor: `${statusTone}22` }]}>
          <Text style={[styles.retroStatusText, { color: statusTone }]}>
            {decision.resolvedAt ? 'Recorded' : 'Pending'}
          </Text>
        </View>
      </View>
      <Text style={styles.retroTitle}>{decision.title}</Text>
      <Text style={baseStyles.textSecondary} numberOfLines={3}>
        {presentation.summary || payload?.whatThisIs || decision.description}
      </Text>
      <View style={styles.retroSignalRow}>
        {presentation.highlights.slice(0, 4).map((highlight) => {
          const target = workspaceSignalTargetForDecisionLabel(highlight.label);
          const content = (
            <>
              <Text style={styles.retroSignalLabel}>{highlight.label}</Text>
              <Text style={styles.retroSignalValue} numberOfLines={1}>
                {highlight.value}
                {target ? ' ›' : ''}
              </Text>
            </>
          );
          return target ? (
            <Pressable
              key={`${highlight.label}-${highlight.value}`}
              style={[styles.retroSignalChip, styles.retroSignalChipPressable]}
              onPress={
                target === 'diff'
                  ? onOpenDiff
                  : target === 'compare'
                    ? openRetroCompare
                    : openEvidence
              }
            >
              {content}
            </Pressable>
          ) : (
            <View key={`${highlight.label}-${highlight.value}`} style={styles.retroSignalChip}>
              {content}
            </View>
          );
        })}
      </View>
      <View style={styles.retroMetaRow}>
        <Text style={styles.retroMeta}>Outcome: {payload?.outcome ?? 'unknown'}</Text>
        {payload?.ciWatch ? (
          <Text style={styles.retroMeta}>
            CI: {payload.ciWatch.result ?? 'unknown'} · {payload.ciWatch.passed ?? 0}/
            {payload.ciWatch.total ?? 0}
          </Text>
        ) : null}
      </View>
      {presentation.textSections.length > 0 ? (
        <Text style={styles.retroMeta} numberOfLines={1}>
          Reports: {presentation.textSections.map((section) => section.title).join(' · ')}
        </Text>
      ) : null}
      {primaryArtifactPath ? (
        <Text style={styles.retroEvidencePath} numberOfLines={1}>
          Evidence: {primaryArtifactPath}
          {presentation.artifactManifest.length > 1
            ? ` +${presentation.artifactManifest.length - 1}`
            : ''}
        </Text>
      ) : null}
      {presentation.artifactManifest.length > 0 ? (
        <RetroEvidencePreview
          run={run}
          artifacts={presentation.artifactManifest}
          gatewayUrl={gatewayUrl}
          artifactAuthHeaders={artifactAuthHeaders}
          onOpenVisual={onOpenVisual}
          onOpenDocument={onOpenDocument}
          onOpenDiffArtifact={onOpenDiffArtifact}
          onOpenArtifact={onOpenArtifact}
          onOpenArtifacts={onOpenArtifacts}
        />
      ) : null}
      {recipePrimaryVisualPair ? (
        <View style={styles.retroEvidencePreview}>
          <BeforeAfterPreview
            pair={recipePrimaryVisualPair}
            authHeaders={artifactAuthHeaders}
            onOpenArtifact={onOpenRecipeCompare}
            eyebrow="Recipe evidence"
            title="Recipe before → after"
            hint="Retro fallback"
            imageHeight={74}
          />
        </View>
      ) : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.retroActionRow}
      >
        <RetroAction
          label="Retro gate"
          value={decision.resolvedAt ? 'recorded' : 'pending'}
          primary
          onPress={onOpenDecision}
        />
        <RetroAction label="Run detail" value="open" onPress={onOpenRun} />
        <RetroAction
          label="Evidence files"
          value={String(presentation.artifactManifest.length)}
          onPress={openEvidence}
        />
        <RetroAction
          label="Before→After"
          value={String(comparePairCount)}
          onPress={openRetroCompare}
          disabled={comparePairCount === 0}
        />
        <RetroAction
          label="Recipe files"
          value={recipeValue}
          onPress={onOpenRecipe}
          disabled={recipeAvailable === false}
        />
        <RetroAction
          label="Diff view"
          value={diffValue}
          onPress={onOpenDiff}
          disabled={diffValue === '-'}
        />
        {run.prNumber ? (
          <RetroAction label="PR" value={`#${run.prNumber}`} onPress={onOpenPR} />
        ) : null}
        {run.slotId ? (
          <>
            <RetroAction label="Slot" value={run.slotId} onPress={onOpenSlot} />
            <RetroAction label="Terminal" value="live" onPress={onOpenTerminal} />
          </>
        ) : null}
      </ScrollView>
    </Pressable>
  );
}

export function RetroEvidencePreview({
  run,
  artifacts,
  gatewayUrl,
  artifactAuthHeaders,
  onOpenVisual,
  onOpenDocument,
  onOpenDiffArtifact,
  onOpenArtifact,
  onOpenArtifacts,
}: {
  run: FamilyObservabilityRunSummary;
  artifacts: ArtifactManifestEntry[];
  gatewayUrl: string;
  artifactAuthHeaders: Record<string, string>;
  onOpenVisual: (uri: string) => void;
  onOpenDocument: (artifact: FamilyObservabilityArtifact) => void;
  onOpenDiffArtifact: (artifact: FamilyObservabilityArtifact) => void;
  onOpenArtifact: (artifactPath: string) => void;
  onOpenArtifacts: () => void;
}) {
  const visualArtifacts = artifacts.filter((artifact) =>
    ['image', 'video'].includes(classifyArtifact(artifact)),
  );
  const visualPairSummary = groupVisualArtifactPairs(artifacts, (artifact) =>
    artifactUrl(gatewayUrl, run.runId, artifact.path),
  );
  const primaryVisualPair = visualPairSummary.pairs[0] ?? null;
  const previewArtifacts = (visualArtifacts.length ? visualArtifacts : artifacts).slice(0, 3);
  const hiddenCount = Math.max(0, artifacts.length - previewArtifacts.length);

  return (
    <View style={styles.retroEvidencePreview}>
      <View style={styles.retroEvidencePreviewHeader}>
        <Text style={styles.retroEvidencePreviewTitle}>Retro evidence</Text>
        <Pressable onPress={onOpenArtifacts}>
          <Text style={styles.retroEvidencePreviewOpen}>Open files</Text>
        </Pressable>
      </View>
      {primaryVisualPair ? (
        <BeforeAfterPreview
          pair={primaryVisualPair}
          authHeaders={artifactAuthHeaders}
          onOpenArtifact={onOpenArtifact}
          title="Retro before → after"
          hint="Tap to inspect"
          imageHeight={74}
        />
      ) : null}
      <View style={styles.focusEvidenceStrip}>
        {previewArtifacts.map((artifact) => {
          const familyArtifact = familyArtifactFromManifest(run, artifact);
          const url = artifactUrl(gatewayUrl, run.runId, artifact.path);
          const mediaType = classifyArtifact(artifact);
          const isDiffArtifact = diffArtifactCandidate([artifact])?.path === artifact.path;
          const onPress =
            mediaType === 'image' || mediaType === 'video'
              ? () => onOpenVisual(url)
              : isDiffArtifact
                ? () => onOpenDiffArtifact(familyArtifact)
                : mediaType === 'document'
                  ? () => onOpenDocument(familyArtifact)
                  : () => onOpenArtifact(artifact.path);
          return (
            <Pressable
              key={`${run.runId}:${artifact.path}`}
              style={styles.focusEvidenceItem}
              onPress={onPress}
            >
              {mediaType === 'image' ? (
                <Image
                  source={{ uri: url, headers: artifactAuthHeaders }}
                  style={styles.focusEvidenceImage}
                />
              ) : (
                <View style={styles.focusEvidenceDoc}>
                  <Text style={styles.focusEvidenceDocType}>
                    {isDiffArtifact ? 'DIFF' : mediaType.toUpperCase()}
                  </Text>
                </View>
              )}
              <Text style={styles.focusEvidencePath} numberOfLines={1}>
                {artifact.path.split('/').pop() ?? artifact.path}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {hiddenCount > 0 ? (
        <Pressable style={styles.focusEvidenceMoreButton} onPress={onOpenArtifacts}>
          <Text style={styles.focusEvidenceMoreText}>+{hiddenCount} more evidence artifacts</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function familyArtifactFromManifest(
  run: FamilyObservabilityRunSummary,
  artifact: ArtifactManifestEntry,
): FamilyObservabilityArtifact {
  return {
    runId: run.runId,
    familyId: run.familyId,
    path: artifact.path,
    purpose: artifact.purpose ?? 'artifact',
    sizeBytes: artifact.sizeBytes,
    source: 'artifact-manifest',
  };
}

export function RetroAction({
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
        styles.retroActionButton,
        primary && styles.retroActionButtonPrimary,
        disabled && styles.familyCockpitDisabled,
      ]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={[styles.retroActionText, primary && styles.retroActionTextPrimary]}>
        {label}
      </Text>
      <Text style={styles.retroActionValue} numberOfLines={1}>
        {value}
      </Text>
    </Pressable>
  );
}

export function FamilyDecisionSignalsPanel({
  run,
  onOpenDecision,
  onOpenArtifacts,
  onOpenCompare,
  onOpenDiff,
}: {
  run: FamilyObservabilityRunSummary;
  onOpenDecision: (decisionId: string) => void;
  onOpenArtifacts: () => void;
  onOpenCompare: () => void;
  onOpenDiff: () => void;
}) {
  const decisions = run.decisions ?? [];
  if (decisions.length === 0) return null;
  const cards = [...decisions]
    .sort((left, right) => Number(Boolean(left.resolvedAt)) - Number(Boolean(right.resolvedAt)))
    .slice(0, 3)
    .map((decision) => ({
      decision,
      presentation: decisionPresentationForFamilyRun(run, decision),
    }));

  return (
    <View style={styles.familyDecisionPanel}>
      <View style={styles.focusRetroHeader}>
        <Text style={styles.familyDecisionTitle}>Review / retro signals</Text>
        <Text style={styles.focusRetroMeta}>
          {decisions.length} decision{decisions.length === 1 ? '' : 's'} ·{' '}
          {decisions.filter((decision) => !decision.resolvedAt).length} pending
        </Text>
      </View>
      {cards.map(({ decision, presentation }) => {
        const resolved = Boolean(decision.resolvedAt);
        const tone = TONE_COLORS[resolved ? 'ok' : presentation.tone];
        return (
          <Pressable
            key={decision.id}
            style={[styles.familyDecisionCard, { borderLeftColor: tone }]}
            onPress={() => onOpenDecision(decision.id)}
          >
            <View style={styles.focusRetroHeader}>
              <View style={[styles.familyDecisionBadge, { backgroundColor: `${tone}22` }]}>
                <Text style={[styles.familyDecisionBadgeText, { color: tone }]}>
                  {resolved ? 'Resolved' : presentation.kindLabel}
                </Text>
              </View>
              <Text style={styles.focusRetroMeta}>
                {presentation.kind === 'retrospective' ? 'Retro' : 'Review'}
              </Text>
            </View>
            <Text style={styles.familyDecisionCardTitle} numberOfLines={2}>
              {presentation.title}
            </Text>
            <Text style={styles.familyDecisionSummary} numberOfLines={2}>
              {presentation.summary || presentation.description}
            </Text>
            {presentation.highlights.length > 0 ? (
              <View style={styles.familyDecisionChipRow}>
                {presentation.highlights.slice(0, 3).map((highlight) => {
                  const highlightTone = TONE_COLORS[highlight.tone ?? 'info'];
                  const target = workspaceSignalTargetForDecisionLabel(highlight.label);
                  const content = (
                    <Text style={[styles.familyDecisionChipText, { color: highlightTone }]}>
                      {highlight.label}: {highlight.value}
                      {target ? ' ›' : ''}
                    </Text>
                  );
                  return target ? (
                    <Pressable
                      key={`${decision.id}:${highlight.label}:${highlight.value}`}
                      style={[styles.familyDecisionChip, { borderColor: `${highlightTone}66` }]}
                      onPress={
                        target === 'diff'
                          ? onOpenDiff
                          : target === 'compare'
                            ? onOpenCompare
                            : onOpenArtifacts
                      }
                    >
                      {content}
                    </Pressable>
                  ) : (
                    <View
                      key={`${decision.id}:${highlight.label}:${highlight.value}`}
                      style={[styles.familyDecisionChip, { borderColor: `${highlightTone}66` }]}
                    >
                      {content}
                    </View>
                  );
                })}
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

export function FamilyRunWorkspaceCard({
  run,
  activeRunId,
  onFocusRun,
  onOpenRun,
  onOpenArtifacts,
  onOpenArtifact,
  gatewayUrl,
  artifactAuthHeaders,
  recipeArtifactCount,
  recipeAvailable,
  selectedFullRun,
  activeTaskProgress,
  fallbackTaskProgress,
  taskProgressError,
  recipeRuns,
  onOpenVisual,
  onOpenDocument,
  onOpenDiffArtifact,
  onOpenRecipe,
  onOpenRecipeArtifact,
  onOpenDiff,
  onOpenTerminal,
  onOpenSlot,
  onOpenPR,
  onOpenDecision,
}: {
  run: FamilyObservabilityRunSummary;
  activeRunId?: string;
  onFocusRun: () => void;
  onOpenRun: () => void;
  onOpenArtifacts: () => void;
  onOpenArtifact: (artifactPath: string) => void;
  gatewayUrl: string;
  artifactAuthHeaders: Record<string, string>;
  recipeArtifactCount: number | null;
  recipeAvailable?: boolean;
  selectedFullRun: Run | null;
  activeTaskProgress: TaskProgressStructured | null;
  fallbackTaskProgress: ReturnType<typeof fallbackTaskProgressSummary> | null;
  taskProgressError?: string | null;
  recipeRuns: RecipeRunArtifactGroup[];
  onOpenVisual: (uri: string) => void;
  onOpenDocument: (artifact: FamilyObservabilityArtifact) => void;
  onOpenDiffArtifact: (artifact: FamilyObservabilityArtifact) => void;
  onOpenRecipe: () => void;
  onOpenRecipeArtifact: (
    recipeRunId: string,
    artifactPath: string,
    filter?: ReturnType<typeof artifactFilterParamForWorkspaceNav>,
  ) => void;
  onOpenDiff: () => void;
  onOpenTerminal: () => void;
  onOpenSlot: () => void;
  onOpenPR: () => void;
  onOpenDecision: (decisionId: string) => void;
}) {
  const statusColor = STATUS_COLORS[run.status] ?? colors.textMuted;
  const readyDecision = selectReadyWorkspaceDecision(run);
  const reviewGateDecision = selectReviewGateWorkspaceDecision(run);
  const retrospective = selectRetrospectiveWorkspaceDecision(run);
  const retrospectivePayload =
    retrospective?.payload?.kind === 'retrospective'
      ? (retrospective.payload as RetrospectivePayload)
      : null;
  const retrospectivePresentation = retrospective
    ? decisionPresentationForFamilyRun(run, retrospective)
    : null;
  const retroArtifacts = retrospectivePresentation?.artifactManifest ?? [];
  const retroVisualPairSummary = groupVisualArtifactPairs(retroArtifacts, (artifact) =>
    artifactUrl(gatewayUrl, run.runId, artifact.path),
  );
  const retroPrimaryVisualPair = retroVisualPairSummary.pairs[0] ?? null;
  const retroTone = !retrospective
    ? colors.textMuted
    : retrospective.resolvedAt
      ? colors.statusOk
      : colors.statusWarn;
  const retroPrimaryArtifactPath = retroArtifacts[0]?.path ?? null;
  const openRetroEvidence = retroPrimaryArtifactPath
    ? () => onOpenArtifact(retroPrimaryArtifactPath)
    : onOpenArtifacts;
  const selected = activeRunId === run.runId;
  const focusDiffValue = run.diffStat.available
    ? `+${run.diffStat.additions} -${run.diffStat.deletions}`
    : run.slotId
      ? 'workspace'
      : '-';
  const retroDiffValue = run.diffStat.available ? 'files' : run.slotId ? 'workspace' : '-';
  const runVisualPairSummary = groupVisualArtifactPairs(run.artifacts, (artifact) =>
    artifactUrl(gatewayUrl, run.runId, artifact.path),
  );
  const runPrimaryVisualPair = runVisualPairSummary.pairs[0] ?? null;
  const recipeVisualPairSummary = groupVisualArtifactPairs(
    selectSlotRecipeArtifactsForPreviewScope(recipeRuns, null),
    (artifact) => artifactUrlForEntry(gatewayUrl, run.runId, artifact),
  );
  const recipePrimaryVisualPair = recipeVisualPairSummary.pairs[0] ?? null;
  const recipePairCount = recipeVisualPairSummary.pairs.length;
  const comparePairCount =
    runVisualPairSummary.pairs.length > 0 ? runVisualPairSummary.pairs.length : recipePairCount;
  const openRecipeCompare = () => {
    if (!recipePrimaryVisualPair) {
      onOpenRecipe();
      return;
    }
    onOpenRecipeArtifact(
      recipeRunIdForVisualPair(recipeRuns, recipePrimaryVisualPair),
      recipePrimaryVisualPair.after.path,
      artifactFilterParamForWorkspaceNav('compare'),
    );
  };
  const openRunCompare = runPrimaryVisualPair
    ? () => onOpenArtifact(runPrimaryVisualPair.after.path)
    : recipePrimaryVisualPair
      ? openRecipeCompare
      : onOpenArtifacts;

  return (
    <View style={[styles.focusRunCard, selected && styles.focusRunCardActive]}>
      <View style={styles.focusRunHeader}>
        <View style={[styles.runStatusBadge, { backgroundColor: `${statusColor}22` }]}>
          <Text style={[styles.runStatusText, { color: statusColor }]}>{run.status}</Text>
        </View>
        <Pressable style={styles.focusRunSelectButton} onPress={onFocusRun}>
          <Text style={styles.focusRunSelectText}>{selected ? 'Selected' : 'Focus'}</Text>
        </Pressable>
      </View>
      <Text style={styles.focusRunTitle} numberOfLines={2}>
        {run.ticketOrPr}
      </Text>
      <Text style={styles.focusRunMeta} numberOfLines={1}>
        {run.flowType} · {run.lane}
        {run.slotId ? ` · ${run.slotId}` : ''}
      </Text>
      {run.summary ? (
        <Text style={baseStyles.textSecondary} numberOfLines={3}>
          {run.summary}
        </Text>
      ) : null}

      <View style={styles.runMetaGrid}>
        <Metric
          label="Evidence files"
          value={String(run.artifacts.length)}
          compact
          onPress={onOpenArtifacts}
        />
        <Metric
          label="Diff view"
          value={focusDiffValue}
          compact
          onPress={onOpenDiff}
          disabled={!run.diffStat.available && !run.slotId}
        />
        <Metric
          label="Ready gate"
          value={readyDecision ? (readyDecision.resolvedAt ? 'resolved' : 'pending') : '-'}
          compact
          onPress={readyDecision ? () => onOpenDecision(readyDecision.id) : undefined}
          disabled={!readyDecision}
        />
        <Metric
          label="Review gate"
          value={
            reviewGateDecision ? (reviewGateDecision.resolvedAt ? 'resolved' : 'pending') : '-'
          }
          compact
          onPress={reviewGateDecision ? () => onOpenDecision(reviewGateDecision.id) : undefined}
          disabled={!reviewGateDecision}
        />
        <Metric
          label="Retro gate"
          value={retrospective ? (retrospective.resolvedAt ? 'recorded' : 'pending') : '-'}
          compact
          onPress={retrospective ? () => onOpenDecision(retrospective.id) : undefined}
          disabled={!retrospective}
        />
        <Metric
          label="Before→After"
          value={String(comparePairCount)}
          compact
          onPress={openRunCompare}
          disabled={comparePairCount === 0}
        />
        <Metric
          label="Recipe files"
          value={
            recipeArtifactCount === null ? '…' : recipeAvailable ? String(recipeArtifactCount) : '-'
          }
          compact
          onPress={onOpenRecipe}
          disabled={recipeAvailable === false}
        />
        <Metric
          label="Progress"
          value={
            activeTaskProgress
              ? `${Math.round(taskProgressPercent(activeTaskProgress))}%`
              : fallbackTaskProgress?.percent != null
                ? `${Math.round(fallbackTaskProgress.percent)}%`
                : fallbackTaskProgress
                  ? 'live'
                  : '-'
          }
          compact
          onPress={onOpenTerminal}
          disabled={!activeTaskProgress && !fallbackTaskProgress}
        />
      </View>

      {activeTaskProgress ? (
        <TaskProgressPanel
          run={selectedFullRun}
          progress={activeTaskProgress}
          error={taskProgressError}
          compact
        />
      ) : fallbackTaskProgress ? (
        <TaskProgressFallbackPanel
          summary={fallbackTaskProgress}
          error={taskProgressError}
          compact
        />
      ) : null}

      {run.artifacts.length > 0 ? (
        <FocusedRunEvidencePreview
          run={run}
          gatewayUrl={gatewayUrl}
          artifactAuthHeaders={artifactAuthHeaders}
          onOpenArtifacts={onOpenArtifacts}
          onOpenArtifact={onOpenArtifact}
          onOpenVisual={onOpenVisual}
          onOpenDocument={onOpenDocument}
          onOpenDiffArtifact={onOpenDiffArtifact}
        />
      ) : null}

      <FocusedRunRecipeQualityPanel
        run={run}
        gatewayUrl={gatewayUrl}
        artifactAuthHeaders={artifactAuthHeaders}
        recipeRuns={recipeRuns}
        onOpenRecipe={onOpenRecipe}
        onOpenRecipeArtifact={onOpenRecipeArtifact}
        onOpenArtifacts={onOpenArtifacts}
      />

      {retrospective ? (
        <View style={styles.focusRetroBox}>
          <View style={styles.focusRetroHeader}>
            <Text style={[styles.focusRetroLabel, { color: retroTone }]}>
              {retrospective.resolvedAt ? 'Retrospective recorded' : 'Retrospective pending'}
            </Text>
            <Text style={styles.focusRetroMeta}>
              {retrospectivePayload?.outcome ?? retrospective.resolvedAction ?? 'review'}
            </Text>
          </View>
          <Text style={styles.focusRetroText} numberOfLines={3}>
            {retrospectivePayload?.deltaLearnings ??
              retrospectivePayload?.workerLearnings ??
              retrospectivePayload?.selfReviewSummary ??
              retrospective.description}
          </Text>
          {retrospectivePayload?.commentsTriageSummary ? (
            <Text style={styles.focusRetroMeta} numberOfLines={1}>
              Comments: {retrospectivePayload.commentsTriageSummary.total} total ·{' '}
              {retrospectivePayload.commentsTriageSummary.real} real ·{' '}
              {retrospectivePayload.commentsTriageSummary.fixed} fixed
            </Text>
          ) : null}
          {retroPrimaryArtifactPath ? (
            <Text style={styles.retroEvidencePath} numberOfLines={1}>
              Evidence: {retroPrimaryArtifactPath}
              {retroArtifacts.length > 1 ? ` +${retroArtifacts.length - 1}` : ''}
            </Text>
          ) : null}
          {retroArtifacts.length > 0 ? (
            <RetroEvidencePreview
              run={run}
              artifacts={retroArtifacts}
              gatewayUrl={gatewayUrl}
              artifactAuthHeaders={artifactAuthHeaders}
              onOpenVisual={onOpenVisual}
              onOpenDocument={onOpenDocument}
              onOpenDiffArtifact={onOpenDiffArtifact}
              onOpenArtifact={onOpenArtifact}
              onOpenArtifacts={onOpenArtifacts}
            />
          ) : null}
          {!retroPrimaryVisualPair && recipePrimaryVisualPair ? (
            <View style={styles.retroEvidencePreview}>
              <BeforeAfterPreview
                pair={recipePrimaryVisualPair}
                authHeaders={artifactAuthHeaders}
                onOpenArtifact={(artifactPath) => {
                  onOpenRecipeArtifact(
                    recipeRunIdForVisualPair(recipeRuns, recipePrimaryVisualPair),
                    artifactPath,
                    artifactFilterParamForWorkspaceNav('compare'),
                  );
                }}
                eyebrow="Recipe evidence"
                title="Recipe before → after"
                hint="Retro fallback"
                imageHeight={74}
              />
            </View>
          ) : null}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.retroActionRow}
          >
            <RetroAction
              label="Retro gate"
              value={retrospective.resolvedAt ? 'recorded' : 'pending'}
              primary
              onPress={() => onOpenDecision(retrospective.id)}
            />
            <RetroAction
              label="Evidence files"
              value={String(retroArtifacts.length)}
              onPress={openRetroEvidence}
              disabled={retroArtifacts.length === 0}
            />
            <RetroAction
              label="Before→After"
              value={String(
                retroVisualPairSummary.pairs.length > 0
                  ? retroVisualPairSummary.pairs.length
                  : recipePairCount,
              )}
              onPress={() => {
                if (retroPrimaryVisualPair) onOpenArtifact(retroPrimaryVisualPair.after.path);
                else openRecipeCompare();
              }}
              disabled={retroVisualPairSummary.pairs.length === 0 && recipePairCount === 0}
            />
            <RetroAction
              label="Recipe files"
              value={
                recipeArtifactCount === null
                  ? '…'
                  : recipeAvailable
                    ? String(recipeArtifactCount)
                    : '-'
              }
              onPress={onOpenRecipe}
              disabled={recipeAvailable === false}
            />
            <RetroAction
              label="Diff view"
              value={retroDiffValue}
              onPress={onOpenDiff}
              disabled={retroDiffValue === '-'}
            />
            {run.prNumber ? (
              <RetroAction label="PR" value={`#${run.prNumber}`} onPress={onOpenPR} />
            ) : null}
            {run.slotId ? (
              <>
                <RetroAction label="Slot" value={run.slotId} onPress={onOpenSlot} />
                <RetroAction label="Terminal" value="live" onPress={onOpenTerminal} />
              </>
            ) : null}
          </ScrollView>
        </View>
      ) : null}

      <FamilyDecisionSignalsPanel
        run={run}
        onOpenDecision={onOpenDecision}
        onOpenArtifacts={onOpenArtifacts}
        onOpenCompare={openRunCompare}
        onOpenDiff={onOpenDiff}
      />

      <View style={styles.runActions}>
        <Pressable style={styles.inlineButton} onPress={onOpenRun}>
          <Text style={styles.inlineButtonText}>Run detail</Text>
        </Pressable>
        <Pressable style={styles.inlineButton} onPress={onOpenArtifacts}>
          <Text style={styles.inlineButtonText}>Evidence files</Text>
        </Pressable>
        {comparePairCount > 0 ? (
          <Pressable style={styles.inlineButton} onPress={openRunCompare}>
            <Text style={styles.inlineButtonText}>Before→After</Text>
          </Pressable>
        ) : null}
        {recipeAvailable ? (
          <Pressable style={styles.inlineButton} onPress={onOpenRecipe}>
            <Text style={styles.inlineButtonText}>Recipe files</Text>
          </Pressable>
        ) : null}
        {run.diffStat.available || run.slotId ? (
          <Pressable style={styles.inlineButton} onPress={onOpenDiff}>
            <Text style={styles.inlineButtonText}>Diff view</Text>
          </Pressable>
        ) : null}
        {run.prNumber ? (
          <Pressable style={styles.inlineButton} onPress={onOpenPR}>
            <Text style={styles.inlineButtonText}>PR</Text>
          </Pressable>
        ) : null}
        {readyDecision ? (
          <Pressable
            style={[styles.inlineButton, !readyDecision.resolvedAt && styles.reviewButton]}
            onPress={() => onOpenDecision(readyDecision.id)}
          >
            <Text
              style={[
                styles.inlineButtonText,
                !readyDecision.resolvedAt && styles.reviewButtonText,
              ]}
            >
              Ready
            </Text>
          </Pressable>
        ) : null}
        {reviewGateDecision ? (
          <Pressable
            style={[styles.inlineButton, !reviewGateDecision.resolvedAt && styles.reviewButton]}
            onPress={() => onOpenDecision(reviewGateDecision.id)}
          >
            <Text
              style={[
                styles.inlineButtonText,
                !reviewGateDecision.resolvedAt && styles.reviewButtonText,
              ]}
            >
              Review
            </Text>
          </Pressable>
        ) : null}
        {retrospective ? (
          <Pressable
            style={[styles.inlineButton, !retrospective.resolvedAt && styles.reviewButton]}
            onPress={() => onOpenDecision(retrospective.id)}
          >
            <Text
              style={[
                styles.inlineButtonText,
                !retrospective.resolvedAt && styles.reviewButtonText,
              ]}
            >
              Retro
            </Text>
          </Pressable>
        ) : null}
        {run.slotId ? (
          <>
            <Pressable style={styles.inlineButton} onPress={onOpenSlot}>
              <Text style={styles.inlineButtonText}>Slot</Text>
            </Pressable>
            <Pressable style={styles.inlineButton} onPress={onOpenTerminal}>
              <Text style={styles.inlineButtonText}>Terminal</Text>
            </Pressable>
          </>
        ) : null}
      </View>
    </View>
  );
}

export function RunCard({
  run,
  active,
  recipeEvidence,
  recipeArtifactCount,
  recipeAvailable,
  gatewayUrl,
  artifactAuthHeaders,
  onFocusRun,
  onOpenRun,
  onOpenArtifacts,
  onOpenCompare,
  onOpenRecipeCompare,
  onOpenRecipe,
  onOpenDiff,
  onOpenDecision,
  onOpenTerminal,
  onOpenSlot,
  onOpenPR,
}: {
  run: FamilyObservabilityRunSummary;
  active: boolean;
  recipeEvidence: FamilyRecipeEvidenceSummary | null;
  recipeArtifactCount: number | null;
  recipeAvailable?: boolean;
  gatewayUrl: string;
  artifactAuthHeaders: Record<string, string>;
  onFocusRun: () => void;
  onOpenRun: () => void;
  onOpenArtifacts: () => void;
  onOpenCompare: (artifactPath: string) => void;
  onOpenRecipeCompare: (artifactPath?: string) => void;
  onOpenRecipe: () => void;
  onOpenDiff: () => void;
  onOpenDecision: (decisionId: string) => void;
  onOpenTerminal: () => void;
  onOpenSlot: () => void;
  onOpenPR: () => void;
}) {
  const statusColor = STATUS_COLORS[run.status] ?? colors.textMuted;
  const readyDecision = selectReadyWorkspaceDecision(run);
  const reviewGateDecision = selectReviewGateWorkspaceDecision(run);
  const retroDecision = selectRetrospectiveWorkspaceDecision(run);
  const recipeValue =
    recipeArtifactCount !== null ? String(recipeArtifactCount) : recipeAvailable ? 'yes' : '-';
  const diffValue = run.diffStat.available
    ? `+${run.diffStat.additions}`
    : run.slotId
      ? 'workspace'
      : '-';
  const visualPairSummary = groupVisualArtifactPairs(run.artifacts, (artifact) =>
    artifactUrl(gatewayUrl, run.runId, artifact.path),
  );
  const primaryVisualPair = visualPairSummary.pairs[0] ?? null;
  const recipePairCount = recipeEvidence?.pairCount ?? 0;
  const recipePrimaryVisualPair = recipeEvidence?.primaryPair ?? null;
  const comparePairCount =
    visualPairSummary.pairs.length > 0 ? visualPairSummary.pairs.length : recipePairCount;
  const previewPair = primaryVisualPair ?? recipePrimaryVisualPair;
  const previewPairIsRecipe = !primaryVisualPair && Boolean(recipePrimaryVisualPair);
  return (
    <Pressable style={[styles.runCard, active && styles.runCardActive]} onPress={onFocusRun}>
      <View style={styles.headerRow}>
        <View style={styles.runTitleBlock}>
          <Text style={styles.runTitle} numberOfLines={1}>
            {run.ticketOrPr}
          </Text>
          <Text style={baseStyles.textMuted} numberOfLines={1}>
            {run.flowType} · {run.lane}
            {run.variant ? ` · ${run.variant}` : ''}
          </Text>
        </View>
        <View style={[styles.runStatusBadge, { backgroundColor: `${statusColor}22` }]}>
          <Text style={[styles.runStatusText, { color: statusColor }]}>{run.status}</Text>
        </View>
      </View>
      {run.summary ? (
        <Text style={baseStyles.textSecondary} numberOfLines={2}>
          {run.summary}
        </Text>
      ) : null}
      <View style={styles.runMetaGrid}>
        <Metric
          label="Evidence files"
          value={String(run.artifacts.length)}
          compact
          onPress={onOpenArtifacts}
        />
        <Metric
          label="Recipe files"
          value={recipeValue}
          compact
          onPress={onOpenRecipe}
          disabled={recipeAvailable === false}
        />
        <Metric
          label="Diff view"
          value={diffValue}
          compact
          onPress={onOpenDiff}
          disabled={!run.diffStat.available && !run.slotId}
        />
        <Metric
          label="Before→After"
          value={String(comparePairCount)}
          compact
          onPress={() => {
            if (primaryVisualPair) onOpenCompare(primaryVisualPair.after.path);
            else onOpenRecipeCompare();
          }}
          disabled={comparePairCount === 0}
        />
        <Metric
          label="Slot"
          value={run.slotId ?? '-'}
          compact
          onPress={onOpenSlot}
          disabled={!run.slotId}
        />
      </View>
      {previewPair ? (
        <View style={styles.runCardComparePreview}>
          <BeforeAfterPreview
            pair={previewPair}
            authHeaders={artifactAuthHeaders}
            onOpenArtifact={(artifactPath) => {
              if (previewPairIsRecipe) onOpenRecipeCompare(artifactPath);
              else onOpenCompare(artifactPath);
            }}
            eyebrow={previewPairIsRecipe ? 'Recipe evidence' : 'Run evidence'}
            title={previewPairIsRecipe ? 'Recipe before → after' : 'Run before → after'}
            hint="Tap side"
            imageHeight={58}
          />
        </View>
      ) : null}
      <View style={styles.runActions}>
        <Pressable
          style={[styles.inlineButton, active && styles.inlineButtonActive]}
          disabled={active}
          onPress={onFocusRun}
        >
          <Text style={[styles.inlineButtonText, active && styles.inlineButtonTextActive]}>
            {active ? 'Focused' : 'Focus'}
          </Text>
        </Pressable>
        <Pressable style={styles.inlineButton} onPress={onOpenRun}>
          <Text style={styles.inlineButtonText}>Run detail</Text>
        </Pressable>
        <Pressable style={styles.inlineButton} onPress={onOpenArtifacts}>
          <Text style={styles.inlineButtonText}>Evidence files</Text>
        </Pressable>
        {comparePairCount > 0 ? (
          <Pressable
            style={styles.inlineButton}
            onPress={() => {
              if (primaryVisualPair) onOpenCompare(primaryVisualPair.after.path);
              else onOpenRecipeCompare();
            }}
          >
            <Text style={styles.inlineButtonText}>Before→After</Text>
          </Pressable>
        ) : null}
        {recipeAvailable ? (
          <Pressable style={styles.inlineButton} onPress={onOpenRecipe}>
            <Text style={styles.inlineButtonText}>Recipe files</Text>
          </Pressable>
        ) : null}
        {run.diffStat.available || run.slotId ? (
          <Pressable style={styles.inlineButton} onPress={onOpenDiff}>
            <Text style={styles.inlineButtonText}>Diff view</Text>
          </Pressable>
        ) : null}
        {run.prNumber ? (
          <Pressable style={styles.inlineButton} onPress={onOpenPR}>
            <Text style={styles.inlineButtonText}>PR</Text>
          </Pressable>
        ) : null}
        {readyDecision ? (
          <Pressable
            style={[styles.inlineButton, !readyDecision.resolvedAt && styles.reviewButton]}
            onPress={() => onOpenDecision(readyDecision.id)}
          >
            <Text
              style={[
                styles.inlineButtonText,
                !readyDecision.resolvedAt && styles.reviewButtonText,
              ]}
            >
              Ready
            </Text>
          </Pressable>
        ) : null}
        {reviewGateDecision ? (
          <Pressable
            style={[styles.inlineButton, !reviewGateDecision.resolvedAt && styles.reviewButton]}
            onPress={() => onOpenDecision(reviewGateDecision.id)}
          >
            <Text
              style={[
                styles.inlineButtonText,
                !reviewGateDecision.resolvedAt && styles.reviewButtonText,
              ]}
            >
              Review
            </Text>
          </Pressable>
        ) : null}
        {retroDecision ? (
          <Pressable
            style={[styles.inlineButton, !retroDecision.resolvedAt && styles.reviewButton]}
            onPress={() => onOpenDecision(retroDecision.id)}
          >
            <Text
              style={[
                styles.inlineButtonText,
                !retroDecision.resolvedAt && styles.reviewButtonText,
              ]}
            >
              Retro
            </Text>
          </Pressable>
        ) : null}
        {run.slotId ? (
          <>
            <Pressable style={styles.inlineButton} onPress={onOpenSlot}>
              <Text style={styles.inlineButtonText}>Slot</Text>
            </Pressable>
            <Pressable style={styles.inlineButton} onPress={onOpenTerminal}>
              <Text style={styles.inlineButtonText}>Terminal</Text>
            </Pressable>
          </>
        ) : null}
      </View>
    </Pressable>
  );
}

export function hasRecipeArtifacts(run: {
  artifacts: Array<{ path: string; purpose?: string | null }>;
}): boolean {
  return hasRecipeArtifactEntries(run.artifacts);
}

export function hasRecipeArtifactEntries(
  artifacts: Array<{ path: string; purpose?: string | null }>,
): boolean {
  return artifacts.some((artifact) => {
    const path = artifact.path.toLowerCase();
    const purpose = artifact.purpose?.toLowerCase() ?? '';
    return path.includes('recipe') || purpose.includes('recipe');
  });
}

export function FocusedRunRecipeQualityPanel({
  run,
  gatewayUrl,
  artifactAuthHeaders,
  recipeRuns,
  onOpenRecipe,
  onOpenRecipeArtifact,
  onOpenArtifacts,
}: {
  run: FamilyObservabilityRunSummary;
  gatewayUrl: string;
  artifactAuthHeaders: Record<string, string>;
  recipeRuns: RecipeRunArtifactGroup[];
  onOpenRecipe: () => void;
  onOpenRecipeArtifact: (
    recipeRunId: string,
    artifactPath: string,
    filter?: ReturnType<typeof artifactFilterParamForWorkspaceNav>,
  ) => void;
  onOpenArtifacts: () => void;
}) {
  const artifact = run.recipeQualityArtifact;
  const quality = run.recipeQuality;
  const previewRecipeRun = recipeRuns.find((group) => group.promoted) ?? recipeRuns[0] ?? null;
  const previewArtifacts = previewRecipeRun ? artifactsForRecipeRun(previewRecipeRun) : [];
  const visualPairSummary = groupVisualArtifactPairs(previewArtifacts, (entry) =>
    artifactUrlForEntry(gatewayUrl, run.runId, entry),
  );
  const primaryVisualPair = visualPairSummary.pairs[0] ?? null;
  if (!artifact && quality.semantic === 'unknown' && !primaryVisualPair) return null;

  const tone = recipeQualityColor(artifact?.verdict ?? quality.semantic);
  const reasons = artifact?.compact.reasons ?? [quality.reasoning].filter(Boolean);
  const guidance = artifact?.compact.better_version_guidance ?? [];
  const findings = [
    ...(artifact?.structural_findings ?? []),
    ...(artifact?.contextual_findings ?? []),
  ];
  return (
    <View style={[styles.recipeQualityBox, { borderColor: `${tone}66` }]}>
      <View style={styles.focusRetroHeader}>
        <View>
          <Text style={[styles.recipeQualityLabel, { color: tone }]}>Recipe quality</Text>
          <Text style={styles.focusRetroMeta}>
            {artifact?.compact.verdict ?? quality.semantic.toUpperCase()}
            {quality.score != null ? ` · ${quality.score}` : ''} · {quality.source}
          </Text>
        </View>
        <View style={styles.retroActionRow}>
          <Pressable style={styles.retroActionButton} onPress={onOpenRecipe}>
            <Text style={styles.retroActionText}>Recipe files</Text>
          </Pressable>
          <Pressable style={styles.retroActionButton} onPress={onOpenArtifacts}>
            <Text style={styles.retroActionText}>Evidence files</Text>
          </Pressable>
        </View>
      </View>
      {reasons.length > 0 ? (
        <View style={styles.recipeQualityList}>
          {reasons.slice(0, 3).map((reason) => (
            <Text key={reason} style={styles.recipeQualityText} numberOfLines={2}>
              • {reason}
            </Text>
          ))}
        </View>
      ) : null}
      {primaryVisualPair ? (
        <BeforeAfterPreview
          pair={primaryVisualPair}
          authHeaders={artifactAuthHeaders}
          onOpenArtifact={(artifactPath) => {
            const target = [primaryVisualPair.before, primaryVisualPair.after].find(
              (entry) => entry.path === artifactPath,
            );
            onOpenRecipeArtifact(
              target?.recipeRunId ?? previewRecipeRun?.id ?? '',
              artifactPath,
              artifactFilterParamForWorkspaceNav('compare'),
            );
          }}
          title="Recipe before → after"
          hint="Tap to inspect"
          imageHeight={72}
        />
      ) : null}
      {guidance.length > 0 ? (
        <View style={styles.recipeQualityGuidance}>
          <Text style={styles.recipeQualityGuidanceTitle}>Better next recipe</Text>
          {guidance.slice(0, 2).map((item) => (
            <Text key={item} style={styles.recipeQualityText} numberOfLines={2}>
              • {item}
            </Text>
          ))}
        </View>
      ) : null}
      {findings.length > 0 ? (
        <Text style={styles.recipeQualityFindings} numberOfLines={1}>
          Findings:{' '}
          {findings
            .slice(0, 3)
            .map((finding) => finding.code)
            .join(' · ')}
        </Text>
      ) : null}
      {artifact?.meta.fallback_used ? (
        <Text style={styles.recipeQualityFindings} numberOfLines={1}>
          Fallback source: {artifact.meta.fallback_source ?? artifact.meta.producer}
        </Text>
      ) : null}
    </View>
  );
}

export function recipeQualityColor(value: string): string {
  if (value === 'pass' || value === 'good' || value === 'PASS') return colors.statusOk;
  if (value === 'fail' || value === 'bad' || value === 'FAIL') return colors.statusFail;
  if (value === 'warn' || value === 'ok' || value === 'WARN') return colors.statusWarn;
  return colors.textMuted;
}

export function FocusedRunEvidencePreview({
  run,
  gatewayUrl,
  artifactAuthHeaders,
  onOpenArtifacts,
  onOpenArtifact,
  onOpenVisual,
  onOpenDocument,
  onOpenDiffArtifact,
}: {
  run: FamilyObservabilityRunSummary;
  gatewayUrl: string;
  artifactAuthHeaders: Record<string, string>;
  onOpenArtifacts: () => void;
  onOpenArtifact: (artifactPath: string) => void;
  onOpenVisual: (uri: string) => void;
  onOpenDocument: (artifact: FamilyObservabilityArtifact) => void;
  onOpenDiffArtifact: (artifact: FamilyObservabilityArtifact) => void;
}) {
  const visualArtifacts = run.artifacts
    .filter((artifact) => ['image', 'video'].includes(classifyArtifact(artifact)))
    .slice(0, 4);
  const previewArtifacts = visualArtifacts.length > 0 ? visualArtifacts : run.artifacts.slice(0, 4);
  const documentArtifacts = run.artifacts
    .filter((artifact) => classifyArtifact(artifact) === 'document')
    .slice(0, 3);
  const diffArtifact = run.artifacts.find(
    (artifact) => diffArtifactCandidate([artifact])?.path === artifact.path,
  );
  const visualPairSummary = groupVisualArtifactPairs(run.artifacts, (artifact) =>
    familyArtifactUrl(gatewayUrl, artifact),
  );
  const primaryVisualPair = visualPairSummary.pairs[0] ?? null;
  const hiddenCount = Math.max(0, run.artifacts.length - previewArtifacts.length);

  return (
    <View style={styles.focusEvidenceBox}>
      <View style={styles.focusEvidenceHeader}>
        <View style={styles.focusEvidenceTitleBlock}>
          <Text style={styles.focusEvidenceTitle}>Run evidence</Text>
          <Text style={styles.focusEvidenceMeta} numberOfLines={1}>
            {run.artifacts.length} artifact
            {run.artifacts.length === 1 ? '' : 's'}
            {visualArtifacts.length ? ` · ${visualArtifacts.length} visual` : ''}
            {visualPairSummary.pairs.length
              ? ` · ${visualPairSummary.pairs.length} before→after pair${
                  visualPairSummary.pairs.length === 1 ? '' : 's'
                }`
              : ''}
            {diffArtifact ? ' · diff available' : ''}
          </Text>
        </View>
        <Pressable style={styles.focusEvidenceOpenButton} onPress={onOpenArtifacts}>
          <Text style={styles.focusEvidenceOpenText}>Evidence files</Text>
        </Pressable>
      </View>
      {primaryVisualPair ? (
        <BeforeAfterPreview
          pair={primaryVisualPair}
          authHeaders={artifactAuthHeaders}
          onOpenArtifact={onOpenArtifact}
          title="Run before → after"
          hint="Tap to inspect"
          imageHeight={74}
        />
      ) : null}
      <View style={styles.focusEvidenceStrip}>
        {previewArtifacts.map((artifact) => {
          const url = familyArtifactUrl(gatewayUrl, artifact);
          const mediaType = classifyArtifact(artifact);
          const isDiffArtifact = diffArtifactCandidate([artifact])?.path === artifact.path;
          const onPress =
            mediaType === 'image' || mediaType === 'video'
              ? () => onOpenVisual(url)
              : isDiffArtifact
                ? () => onOpenDiffArtifact(artifact)
                : mediaType === 'document'
                  ? () => onOpenDocument(artifact)
                  : () => onOpenArtifact(artifact.path);
          return (
            <Pressable
              key={`${artifact.runId}:${artifact.path}`}
              style={styles.focusEvidenceItem}
              onPress={onPress}
            >
              {mediaType === 'image' ? (
                <Image
                  source={{ uri: url, headers: artifactAuthHeaders }}
                  style={styles.focusEvidenceImage}
                />
              ) : (
                <View style={styles.focusEvidenceDoc}>
                  <Text style={styles.focusEvidenceDocType}>
                    {isDiffArtifact ? 'DIFF' : mediaType.toUpperCase()}
                  </Text>
                </View>
              )}
              <Text style={styles.focusEvidencePath} numberOfLines={1}>
                {artifact.path.split('/').pop() ?? artifact.path}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {documentArtifacts.length > 0 ? (
        <View style={styles.focusEvidenceDocRow}>
          {documentArtifacts.map((artifact) => {
            const isDiffArtifact = diffArtifactCandidate([artifact])?.path === artifact.path;
            return (
              <Pressable
                key={`doc:${artifact.runId}:${artifact.path}`}
                style={styles.focusEvidenceDocChip}
                onPress={() =>
                  isDiffArtifact ? onOpenDiffArtifact(artifact) : onOpenDocument(artifact)
                }
              >
                <Text style={styles.focusEvidenceDocChipText} numberOfLines={1}>
                  {isDiffArtifact ? 'Diff' : (artifact.path.split('/').pop() ?? artifact.path)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {hiddenCount > 0 ? (
        <Pressable style={styles.focusEvidenceMoreButton} onPress={onOpenArtifacts}>
          <Text style={styles.focusEvidenceMoreText}>+{hiddenCount} more artifacts</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function EvidenceGroupCard({
  group,
  gatewayUrl,
  artifactAuthHeaders,
  onOpenDocument,
  onOpenDiffArtifact,
  onOpenVisual,
  onOpenRun,
  onOpenArtifacts,
  onOpenRecipe,
  onOpenDiff,
  onOpenTerminal,
  onOpenSlot,
}: {
  group: FamilyEvidenceGroup;
  gatewayUrl: string;
  artifactAuthHeaders: Record<string, string>;
  onOpenDocument: (artifact: FamilyObservabilityArtifact) => void;
  onOpenDiffArtifact: (artifact: FamilyObservabilityArtifact) => void;
  onOpenVisual: (uri: string) => void;
  onOpenRun: (runId: string) => void;
  onOpenArtifacts: (runId: string, artifactPath?: string) => void;
  onOpenRecipe: (runId: string) => void;
  onOpenDiff: (run: NonNullable<FamilyEvidenceGroup['run']>) => void;
  onOpenTerminal: (slotId: string, runId: string) => void;
  onOpenSlot: (slotId: string, runId: string) => void;
}) {
  const visibleArtifacts = group.artifacts.slice(0, MAX_ARTIFACTS_PER_FAMILY_EVIDENCE_GROUP);
  const hiddenArtifacts = group.artifacts.length - visibleArtifacts.length;
  const sourceRun = group.run;
  const groupWorkspaceRunId = sourceRun?.runId ?? group.artifacts[0]?.runId ?? null;
  const visualPairs = groupVisualArtifactPairs(group.artifacts, (artifact) =>
    familyArtifactUrl(gatewayUrl, artifact),
  ).pairs;
  const primaryVisualPair = visualPairs[0] ?? null;
  const openGroupPairArtifact = (artifactPath: string) => {
    const artifact = group.artifacts.find((item) => item.path === artifactPath);
    const targetRunId = artifact?.runId ?? groupWorkspaceRunId;
    if (targetRunId) {
      onOpenArtifacts(targetRunId, artifactPath);
    }
  };
  return (
    <View style={[styles.evidenceGroupCard, group.capturedBeforeRun && styles.carriedGroupCard]}>
      <View style={styles.evidenceGroupHeader}>
        <View style={styles.evidenceGroupTitleWrap}>
          <Text style={styles.evidenceGroupTitle}>{group.title}</Text>
          <Text style={styles.evidenceGroupMeta} numberOfLines={2}>
            {group.subtitle}
          </Text>
        </View>
        <View style={styles.evidenceGroupHeaderActions}>
          <Text style={styles.evidenceGroupCount}>{group.artifacts.length}</Text>
          {groupWorkspaceRunId ? (
            <Pressable
              style={styles.evidenceGroupWorkspaceButton}
              onPress={() => onOpenArtifacts(groupWorkspaceRunId)}
            >
              <Text style={styles.evidenceGroupWorkspaceText}>Workspace</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
      {primaryVisualPair ? (
        <BeforeAfterPreview
          pair={primaryVisualPair}
          authHeaders={artifactAuthHeaders}
          onOpenArtifact={openGroupPairArtifact}
          eyebrow="Family evidence"
          title="Evidence before → after"
          hint={`${visualPairs.length} pair${visualPairs.length === 1 ? '' : 's'}`}
          imageHeight={74}
        />
      ) : null}
      <View style={styles.artifactGrid}>
        {visibleArtifacts.map((artifact) => {
          const url = familyArtifactUrl(gatewayUrl, artifact);
          const mediaType = classifyArtifact(artifact);
          const kind = familyArtifactKind(artifact);
          const isDiffArtifact = diffArtifactCandidate([artifact])?.path === artifact.path;
          return (
            <ArtifactCell key={`${artifact.runId}:${artifact.path}`}>
              <View style={styles.artifactKindRow}>
                <Text style={[styles.artifactKindText, artifactKindStyle(kind)]}>
                  {familyEvidenceKindLabel(kind)}
                </Text>
                {group.run ? (
                  <Text style={styles.artifactRunText}>{familyRunBadgeLabel(group.run)}</Text>
                ) : null}
              </View>
              <ArtifactCard
                url={url}
                path={artifact.path}
                purpose={artifact.purpose}
                sizeBytes={artifact.sizeBytes}
                authHeaders={artifactAuthHeaders}
                onPressImage={mediaType === 'image' ? () => onOpenVisual(url) : undefined}
                onPressVideo={mediaType === 'video' ? () => onOpenVisual(url) : undefined}
                onPressDocument={
                  mediaType === 'document'
                    ? isDiffArtifact
                      ? () => onOpenDiffArtifact(artifact)
                      : () => onOpenDocument(artifact)
                    : undefined
                }
                documentLabel={isDiffArtifact ? 'DIFF' : undefined}
                documentHint={isDiffArtifact ? 'Tap to review diff' : undefined}
              />
              <Pressable
                style={styles.artifactWorkspaceButton}
                onPress={() => onOpenArtifacts(artifact.runId, artifact.path)}
              >
                <Text style={styles.artifactWorkspaceText}>
                  {isDiffArtifact ? 'Open diff' : 'Open in artifacts'}
                </Text>
              </Pressable>
            </ArtifactCell>
          );
        })}
      </View>
      {hiddenArtifacts > 0 ? (
        groupWorkspaceRunId ? (
          <Pressable
            style={styles.evidenceGroupMoreButton}
            onPress={() => onOpenArtifacts(groupWorkspaceRunId)}
          >
            <Text style={styles.evidenceGroupMore}>
              +{hiddenArtifacts} more in this batch · open all
            </Text>
          </Pressable>
        ) : (
          <Text style={styles.evidenceGroupMore}>+{hiddenArtifacts} more in this batch</Text>
        )
      ) : null}
      {sourceRun ? (
        <View style={styles.evidenceGroupActions}>
          <Pressable style={styles.inlineButton} onPress={() => onOpenRun(sourceRun.runId)}>
            <Text style={styles.inlineButtonText}>Run detail</Text>
          </Pressable>
          <Pressable style={styles.inlineButton} onPress={() => onOpenArtifacts(sourceRun.runId)}>
            <Text style={styles.inlineButtonText}>Evidence files</Text>
          </Pressable>
          {hasRecipeArtifactEntries(group.artifacts) ? (
            <Pressable style={styles.inlineButton} onPress={() => onOpenRecipe(sourceRun.runId)}>
              <Text style={styles.inlineButtonText}>Recipe files</Text>
            </Pressable>
          ) : null}
          {sourceRun.diffStat.available || sourceRun.slotId ? (
            <Pressable style={styles.inlineButton} onPress={() => onOpenDiff(sourceRun)}>
              <Text style={styles.inlineButtonText}>Diff view</Text>
            </Pressable>
          ) : null}
          {sourceRun.slotId ? (
            <>
              <Pressable
                style={styles.inlineButton}
                onPress={() => onOpenSlot(sourceRun.slotId!, sourceRun.runId)}
              >
                <Text style={styles.inlineButtonText}>Slot</Text>
              </Pressable>
              <Pressable
                style={styles.inlineButton}
                onPress={() => onOpenTerminal(sourceRun.slotId!, sourceRun.runId)}
              >
                <Text style={styles.inlineButtonText}>Terminal</Text>
              </Pressable>
            </>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export function artifactKindStyle(kind: ReturnType<typeof familyArtifactKind>) {
  if (kind === 'before') return styles.artifactKindBefore;
  if (kind === 'after') return styles.artifactKindAfter;
  return styles.artifactKindSetup;
}

export function ArtifactCell({ children }: { children: React.ReactNode }) {
  return <View style={styles.artifactCell}>{children}</View>;
}

export function Metric({
  label,
  value,
  compact = false,
  onPress,
  disabled,
}: {
  label: string;
  value: string;
  compact?: boolean;
  onPress?: () => void;
  disabled?: boolean;
}) {
  const content = (
    <>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue} numberOfLines={1}>
        {value}
      </Text>
    </>
  );
  if (onPress) {
    return (
      <Pressable
        style={[
          styles.metricItem,
          compact && styles.metricItemCompact,
          disabled && styles.familyCockpitDisabled,
        ]}
        onPress={onPress}
        disabled={disabled}
      >
        {content}
      </Pressable>
    );
  }
  return <View style={[styles.metricItem, compact && styles.metricItemCompact]}>{content}</View>;
}

export function workflowStateColor(state: FamilyObservabilitySnapshot['workflowState']): string {
  if (state === 'complete') return colors.statusOk;
  if (state === 'failed') return colors.statusFail;
  return colors.statusWarn;
}

export function formatDateTime(value: string): string {
  return new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}
