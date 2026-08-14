import { Image, Pressable, ScrollView, Text, View } from 'react-native';

import {
  type RecipeRunArtifactGroup,
  type Run,
  type RunDecision,
  type RunStep,
} from '@farmslot/protocol';

import { BeforeAfterPreview } from '../../../components/BeforeAfterPreview';
import {
  type ArtifactHttpHeaders,
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
import { type DecisionPresentation, presentDecision } from '../../../lib/decision-presentation';
import { diffArtifactCandidate } from '../../../lib/diff';
import {
  hasRunWorkspaceDiff,
  isActionableWorkspaceDiffValue,
  runWorkspaceDiffValue,
  selectSlotGatePreviewArtifacts,
  selectSlotRecipeArtifactsForPreviewScope,
  type SlotCompareTarget,
  type SlotWorkspaceGateSummary,
  type SlotWorkspaceRetroSummary,
  summarizeSlotWorkspaceRetro,
  workspaceGateDiffMetricValue,
} from '../../../lib/slot-workspace';
import { baseStyles, colors } from '../../../lib/theme';
import {
  artifactFilterParamForArtifactPath,
  recipeWorkspaceScopeLabel,
  workspaceSignalTargetForDecisionLabel,
} from '../../../lib/workspace-navigation';
import { formatDuration } from '../../workspace-shared/format';
import { TONE_COLORS } from '../run-detail-model';
import { runDetailStyles as styles } from '../styles/run-detail.styles';

export function PipelineStepCard({
  step,
  index,
  expanded,
  allowReplay,
  replaying,
  onToggle,
  onOpenArtifact,
  onReplayStep,
  onDiagnoseFailure,
}: {
  step: RunStep;
  index: number;
  expanded: boolean;
  allowReplay: boolean;
  replaying: boolean;
  onToggle: () => void;
  onOpenArtifact: (artifactPath: string) => void;
  onReplayStep: (skipPrepare?: boolean) => void;
  onDiagnoseFailure: () => void;
}) {
  const statusColor = stepStatusColor(step.status);
  const artifacts = collectStepArtifacts(step);
  return (
    <View style={[styles.stepCard, expanded && styles.stepCardExpanded]}>
      <Pressable onPress={onToggle}>
        <View style={styles.row}>
          <View style={styles.stepLeft}>
            <Text style={[styles.stepIcon, { color: statusColor }]}>{stepIcon(step.status)}</Text>
            <View style={styles.stepTitleWrap}>
              <Text style={styles.stepName} numberOfLines={1}>
                {index + 1}. {step.name}
              </Text>
              {step.detail && (
                <Text style={styles.stepDetailPreview} numberOfLines={expanded ? 3 : 1}>
                  {step.detail}
                </Text>
              )}
            </View>
          </View>
          <View style={styles.stepRight}>
            {step.durationMs != null && (
              <Text style={styles.stepDurationText}>{formatDuration(step.durationMs)}</Text>
            )}
            <Text style={styles.expandGlyph}>{expanded ? '⌃' : '⌄'}</Text>
          </View>
        </View>
      </Pressable>
      {expanded && (
        <View style={styles.stepExpandedBody}>
          {(allowReplay || replaying) && (
            <View style={styles.stepReplayPanel}>
              <View style={styles.stepReplayTextWrap}>
                <Text style={styles.stepReplayTitle}>Retry controls</Text>
                <Text style={styles.stepReplayHint}>
                  Replay this step and every following step on the run engine.
                </Text>
              </View>
              <View style={styles.stepReplayActions}>
                <Pressable
                  style={[styles.stepReplayButton, replaying && styles.stepReplayButtonDisabled]}
                  disabled={!allowReplay}
                  onPress={() => onReplayStep()}
                >
                  <Text style={styles.stepReplayButtonText}>
                    {replaying ? 'Retrying…' : 'Retry from here'}
                  </Text>
                </Pressable>
                {step.name === 'prepare' ? (
                  <Pressable
                    style={[
                      styles.stepReplayButton,
                      styles.stepReplayButtonSecondary,
                      replaying && styles.stepReplayButtonDisabled,
                    ]}
                    disabled={!allowReplay}
                    onPress={() => onReplayStep(true)}
                  >
                    <Text style={styles.stepReplayButtonText}>Warm retry</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          )}
          {step.status === 'failed' && (
            <View style={styles.stepDiagnosePanel}>
              <View style={styles.stepReplayTextWrap}>
                <Text style={styles.stepReplayTitle}>Failure diagnosis</Text>
                <Text style={styles.stepReplayHint}>
                  Ask gateway intelligence to inspect the failed step and propose read-only recovery
                  evidence first.
                </Text>
              </View>
              <Pressable style={styles.stepDiagnoseButton} onPress={onDiagnoseFailure}>
                <Text style={styles.stepDiagnoseButtonText}>Diagnose in Co-Pilot</Text>
              </Pressable>
            </View>
          )}
          <View style={styles.stepMetaGrid}>
            <StepMeta label="Status" value={step.status} tone={statusColor} />
            <StepMeta label="Started" value={formatTimestamp(step.startedAt)} />
            <StepMeta label="Completed" value={formatTimestamp(step.completedAt)} />
            <StepMeta label="Duration" value={formatDuration(step.durationMs)} />
          </View>
          {artifacts.length > 0 && (
            <View style={styles.stepBlock}>
              <Text style={styles.stepBlockTitle}>Evidence files</Text>
              {artifacts.slice(0, 8).map((artifact) => (
                <Pressable
                  key={artifact}
                  style={styles.stepArtifactButton}
                  onPress={() => onOpenArtifact(artifact)}
                >
                  <Text style={styles.stepArtifact} numberOfLines={1}>
                    {artifact}
                  </Text>
                  <Text style={styles.stepArtifactOpen}>Open file</Text>
                </Pressable>
              ))}
            </View>
          )}
          {step.inputs && <StructuredDataBlock title="Inputs" value={step.inputs} />}
          {step.outputs && <StructuredDataBlock title="Outputs" value={step.outputs} />}
        </View>
      )}
    </View>
  );
}
export function RunFocusedArtifactCard({
  artifactPath,
  recipeRunId,
  slotId,
  familyId,
  prNumber,
  recipeAvailable,
  diffAvailable,
  diffValue,
  comparePairCount,
  onOpenArtifact,
  onOpenFiles,
  onOpenRecipe,
  onOpenDiff,
  onOpenCompare,
  onOpenSlot,
  onOpenTerminal,
  onOpenFamily,
  onOpenPR,
}: {
  artifactPath: string;
  recipeRunId: string;
  slotId?: string | null;
  familyId?: string | null;
  prNumber?: number | null;
  recipeAvailable?: boolean;
  diffAvailable: boolean;
  diffValue: string;
  comparePairCount: number;
  onOpenArtifact: () => void;
  onOpenFiles: () => void;
  onOpenRecipe: () => void;
  onOpenDiff: () => void;
  onOpenCompare: () => void;
  onOpenSlot: () => void;
  onOpenTerminal: () => void;
  onOpenFamily: () => void;
  onOpenPR: () => void;
}) {
  const isDiff = Boolean(diffArtifactCandidate([{ path: artifactPath }]));
  const artifactKind = runFocusedArtifactKindLabel(artifactPath);
  const recipeScoped = recipeRunId !== DECISION_EVIDENCE_RECIPE_RUN_PARAM;
  const recipeScopeLabel = recipeWorkspaceScopeLabel(recipeRunId);
  return (
    <View style={styles.focusedArtifactCard}>
      <View style={styles.workspaceHeader}>
        <View style={styles.focusedArtifactTitleBlock}>
          <Text style={styles.focusedArtifactEyebrow}>Focused artifact</Text>
          <Text style={styles.focusedArtifactPath} numberOfLines={2}>
            {artifactPath}
          </Text>
          <Text style={styles.focusedArtifactMeta} numberOfLines={1}>
            {artifactKind} · {recipeScoped ? 'recipe context' : 'decision evidence'}
          </Text>
        </View>
        <Pressable
          style={styles.focusedArtifactPrimaryButton}
          onPress={isDiff ? onOpenDiff : onOpenArtifact}
        >
          <Text style={styles.focusedArtifactPrimaryText}>{isDiff ? 'Open diff' : 'Open'}</Text>
        </Pressable>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.cockpitRail}
      >
        <CockpitTile label="Files" value="context" onPress={onOpenFiles} />
        <CockpitTile
          label="Recipe files"
          value={recipeAvailable === false ? '-' : recipeScopeLabel}
          onPress={onOpenRecipe}
          disabled={recipeAvailable === false}
        />
        <CockpitTile
          label="Diff"
          value={isDiff ? 'focused' : diffValue}
          onPress={onOpenDiff}
          disabled={!diffAvailable}
        />
        <CockpitTile
          label="Before→After"
          value={String(comparePairCount)}
          onPress={onOpenCompare}
          disabled={comparePairCount === 0}
        />
        <CockpitTile label="Slot" value={slotId ?? '-'} onPress={onOpenSlot} disabled={!slotId} />
        <CockpitTile
          label="Terminal"
          value={slotId ? 'live' : '-'}
          onPress={onOpenTerminal}
          disabled={!slotId}
        />
        <CockpitTile
          label="Family"
          value={shortId(familyId)}
          onPress={onOpenFamily}
          disabled={!familyId}
        />
        <CockpitTile
          label="PR"
          value={prNumber ? `#${prNumber}` : '-'}
          onPress={onOpenPR}
          disabled={!prNumber}
        />
      </ScrollView>
    </View>
  );
}
export function runFocusedArtifactKindLabel(artifactPath: string): string {
  if (diffArtifactCandidate([{ path: artifactPath }])) return 'diff';
  const filter = artifactFilterParamForArtifactPath(artifactPath);
  if (filter === 'recipes') return 'recipe file';
  if (filter === 'visual') return 'visual evidence';
  return 'evidence file';
}
export function RunReviewWorkspaceSummary({
  run,
  gates,
  gatewayUrl,
  artifactAuthHeaders,
  recipeArtifactCount,
  recipeAvailable,
  recipeRuns,
  selectedRecipeRunId,
  compareTarget,
  onOpenDecision,
  onOpenArtifacts,
  onOpenRecipeArtifact,
  onOpenRecipe,
  onOpenDiff,
  onOpenFamily,
  onOpenFamilyRetros,
  onOpenTerminal,
  onOpenSlot,
  onOpenPR,
  onOpenCompareTarget,
}: {
  run: Run;
  gates: SlotWorkspaceGateSummary[];
  gatewayUrl: string;
  artifactAuthHeaders: ArtifactHttpHeaders;
  recipeArtifactCount: number | null;
  recipeAvailable?: boolean;
  recipeRuns: RecipeRunArtifactGroup[];
  selectedRecipeRunId: string | null;
  compareTarget: SlotCompareTarget | null;
  onOpenDecision: (decisionId: string) => void;
  onOpenArtifacts: (artifactPath?: string) => void;
  onOpenRecipeArtifact: (artifactPath: string, recipeRunId: string | null) => void;
  onOpenRecipe: () => void;
  onOpenDiff: () => void;
  onOpenFamily: () => void | undefined;
  onOpenFamilyRetros: () => void | undefined;
  onOpenTerminal: () => void | undefined;
  onOpenSlot: () => void | undefined;
  onOpenPR: () => void;
  onOpenCompareTarget: () => void;
}) {
  const manifest = extractRunArtifactManifest(run);
  const manifestCount = manifest.length;
  const gate = gates[0] ?? null;
  const retroSummary = summarizeSlotWorkspaceRetro(run);
  const previewArtifacts = manifest.slice(0, 4);
  const visualPairSummary = groupVisualArtifactPairs(manifest, (artifact) =>
    artifactUrlForEntry(gatewayUrl, run.id, artifact),
  );
  const primaryVisualPair = visualPairSummary.pairs[0] ?? null;
  const runVisualPairCount = visualPairSummary.pairs.length;
  const recipeVisualPairSummary = groupVisualArtifactPairs(
    selectSlotRecipeArtifactsForPreviewScope(recipeRuns, selectedRecipeRunId),
    (artifact) => artifactUrlForEntry(gatewayUrl, run.id, artifact),
  );
  const recipePrimaryVisualPair = recipeVisualPairSummary.pairs[0] ?? null;
  const priorityVisualPair = primaryVisualPair ?? recipePrimaryVisualPair;
  const priorityVisualPairIsRecipe = !primaryVisualPair && Boolean(recipePrimaryVisualPair);
  const priorityRecipeRunId = recipePrimaryVisualPair
    ? (recipeRuns.find((group) => {
        const artifacts = artifactsForRecipeRun(group);
        return artifacts.some(
          (artifact) =>
            artifact.path === recipePrimaryVisualPair.before.path ||
            artifact.path === recipePrimaryVisualPair.after.path,
        );
      })?.id ??
      selectedRecipeRunId ??
      recipeRuns[0]?.id ??
      CURRENT_ARTIFACTS_RECIPE_RUN_PARAM)
    : null;
  const openPriorityVisualArtifact = (artifactPath: string) => {
    if (!priorityVisualPairIsRecipe) {
      onOpenArtifacts(artifactPath);
      return;
    }
    onOpenRecipeArtifact(artifactPath, priorityRecipeRunId);
  };
  const openPriorityCompare = () => {
    if (primaryVisualPair) {
      onOpenArtifacts(primaryVisualPair.after.path);
      return;
    }
    if (recipePrimaryVisualPair) {
      onOpenRecipeArtifact(recipePrimaryVisualPair.after.path, priorityRecipeRunId);
    }
  };
  const workspaceVisualPairCount = compareTarget?.pairCount ?? runVisualPairCount;
  const tone = colors.accent;
  const diffValue = runWorkspaceDiffValue(run, gate);
  const diffAvailable = hasRunWorkspaceDiff(run, gate);
  return (
    <View style={styles.workspaceCard}>
      <View style={styles.workspaceHeader}>
        <View style={[styles.workspaceBadge, { backgroundColor: tone + '22' }]}>
          <Text style={[styles.workspaceBadgeText, { color: tone }]}>Run evidence</Text>
        </View>
        {gate ? (
          <Pressable
            testID="companion-open-run-gate"
            style={styles.workspaceGateButton}
            onPress={() => onOpenDecision(gate.decision.id)}
          >
            <Text style={[styles.workspaceGateButtonText, { color: tone }]}>Gate</Text>
          </Pressable>
        ) : (
          <Text style={styles.workspaceRunMeta} numberOfLines={1}>
            {run.slotId ?? 'no slot'} · {run.status}
          </Text>
        )}
      </View>
      <Text style={styles.workspaceTitle} numberOfLines={2}>
        {run.summary ?? run.ticketOrPr}
      </Text>
      <Text style={styles.workspaceSummary} numberOfLines={4}>
        Review the run evidence here; gate blockers, review history, package freshness, and actions
        stay in the Gate tab.
      </Text>
      {manifest.length ? (
        <>
          <View style={styles.workspaceEvidenceRow}>
            {manifest.slice(0, 4).map((artifact) => (
              <Pressable
                key={artifact.path}
                style={styles.workspaceEvidenceChip}
                onPress={() => onOpenArtifacts(artifact.path)}
              >
                <Text style={styles.workspaceEvidenceChipText} numberOfLines={1}>
                  {artifact.path.split('/').pop() ?? artifact.path}
                </Text>
              </Pressable>
            ))}
            {manifest.length > 4 ? (
              <Pressable style={styles.workspaceEvidenceChip} onPress={() => onOpenArtifacts()}>
                <Text style={styles.workspaceEvidenceChipText}>+{manifest.length - 4} more</Text>
              </Pressable>
            ) : null}
          </View>
          {previewArtifacts.length > 0 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.workspacePreviewStrip}
            >
              {previewArtifacts.map((artifact) => {
                const mediaType = classifyArtifact(artifact);
                return (
                  <Pressable
                    key={artifact.path}
                    style={styles.workspacePreviewButton}
                    onPress={() => onOpenArtifacts(artifact.path)}
                  >
                    {mediaType === 'image' ? (
                      <Image
                        source={artifactSource(
                          artifactUrlForEntry(gatewayUrl, run.id, artifact),
                          artifactAuthHeaders,
                        )}
                        style={styles.workspacePreviewImage}
                        resizeMode="cover"
                      />
                    ) : (
                      <View style={styles.workspacePreviewDocumentTile}>
                        <Text style={styles.workspacePreviewDocumentKind}>
                          {mediaType.toUpperCase()}
                        </Text>
                        <Text style={styles.workspacePreviewDocumentPath} numberOfLines={2}>
                          {artifact.path.split('/').pop() ?? artifact.path}
                        </Text>
                      </View>
                    )}
                  </Pressable>
                );
              })}
            </ScrollView>
          ) : null}
        </>
      ) : null}
      {priorityVisualPair ? (
        <RunBeforeAfterPriorityPanel
          pair={priorityVisualPair}
          pairCount={primaryVisualPair ? runVisualPairCount : recipeVisualPairSummary.pairs.length}
          authHeaders={artifactAuthHeaders}
          eyebrow={priorityVisualPairIsRecipe ? 'Recipe evidence' : 'Review first'}
          title={
            priorityVisualPairIsRecipe ? 'Recipe before → after' : 'Run before → after evidence'
          }
          copy={
            priorityVisualPairIsRecipe
              ? 'Recipe evidence has the clearest visible delta for this run.'
              : 'Confirm the visible change before using retry, review, or recipe controls.'
          }
          onOpenArtifact={openPriorityVisualArtifact}
          onOpenCompare={openPriorityCompare}
          onOpenArtifacts={() => onOpenArtifacts()}
          onOpenRecipe={onOpenRecipe}
          onOpenDiff={onOpenDiff}
          onOpenSlot={onOpenSlot}
          onOpenTerminal={onOpenTerminal}
          artifactCount={manifestCount}
          recipeArtifactCount={recipeArtifactCount}
          recipeAvailable={recipeAvailable}
          diffValue={diffValue}
          slotId={run.slotId}
        />
      ) : null}
      <RunWorkspaceCockpit
        diffValue={diffValue}
        diffAvailable={diffAvailable}
        manifestCount={manifestCount}
        recipeArtifactCount={recipeArtifactCount}
        recipeAvailable={recipeAvailable}
        recipeScopeLabel={recipeWorkspaceScopeLabel(selectedRecipeRunId)}
        familyId={run.familyId}
        gateCount={gates.length}
        readyGate={gates.find((workspaceGate) => workspaceGate.label === 'Ready workspace') ?? null}
        reviewGate={
          gates.find(
            (workspaceGate) =>
              workspaceGate.label === 'Review workspace' ||
              workspaceGate.label === 'No-change review',
          ) ?? null
        }
        retroSummary={retroSummary}
        visualPairCount={workspaceVisualPairCount}
        pendingCount={(run.decisions ?? []).filter((decision) => !decision.resolvedAt).length}
        terminalAvailable={Boolean(run.slotId)}
        slotId={run.slotId}
        prNumber={run.prNumber}
        onOpenTerminal={onOpenTerminal}
        onOpenSlot={onOpenSlot}
        onOpenPR={onOpenPR}
        onOpenArtifacts={() => onOpenArtifacts()}
        onOpenCompare={onOpenCompareTarget}
        onOpenRecipe={onOpenRecipe}
        onOpenDiff={onOpenDiff}
        onOpenFamily={onOpenFamily}
        onOpenFamilyRetros={onOpenFamilyRetros}
        onOpenGate={(workspaceGate) => onOpenDecision(workspaceGate.decision.id)}
        onOpenRetro={(retro) => onOpenDecision(retro.decision.id)}
      />
      {selectedRecipeRunId ? (
        <Text style={styles.workspaceRecipeContext} numberOfLines={1}>
          Recipe context: {selectedRecipeRunId}
        </Text>
      ) : null}
    </View>
  );
}
export function RunWorkspaceGateRail({
  gates,
  runId,
  artifactManifest,
  gatewayUrl,
  artifactAuthHeaders,
  compareTarget,
  compareFallbackPair,
  compareFallbackPairIsRecipe,
  onOpenDecision,
  onOpenArtifacts,
  onOpenCompareTarget,
  onOpenCompareFallbackArtifact,
  onOpenDiff,
}: {
  gates: SlotWorkspaceGateSummary[];
  runId: string;
  artifactManifest: ArtifactManifestEntry[];
  gatewayUrl: string;
  artifactAuthHeaders: ArtifactHttpHeaders;
  compareTarget: SlotCompareTarget | null;
  compareFallbackPair: VisualArtifactPair | null;
  compareFallbackPairIsRecipe: boolean;
  onOpenDecision: (decisionId: string) => void;
  onOpenArtifacts: (artifactPath?: string) => void;
  onOpenCompareTarget: () => void;
  onOpenCompareFallbackArtifact: (artifactPath: string) => void;
  onOpenDiff: () => void;
}) {
  return (
    <View style={styles.workspaceGateRailPanel}>
      <View style={styles.workspaceGateRailHeader}>
        <Text style={styles.workspaceGateRailTitle}>Ready / review gates</Text>
        <Text style={styles.workspaceGateRailMeta}>
          {gates.filter((gate) => !gate.resolved).length} pending / {gates.length}
        </Text>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.workspaceGateRail}
      >
        {gates.map((gate) => {
          const tone = workspaceGateToneColor(gate);
          const gateArtifacts = selectSlotGatePreviewArtifacts(
            gate,
            artifactManifest,
            gate.artifactPaths.length,
          );
          const visualPairSummary = groupVisualArtifactPairs(gateArtifacts, (artifact) =>
            artifactUrlForEntry(gatewayUrl, runId, artifact),
          );
          const primaryVisualPair = visualPairSummary.pairs[0] ?? null;
          const fallbackVisualPair = primaryVisualPair ? null : compareFallbackPair;
          const comparePairCount =
            visualPairSummary.pairs.length > 0
              ? visualPairSummary.pairs.length
              : (compareTarget?.pairCount ?? 0);
          const diffValue = workspaceGateDiffMetricValue(gate);
          const diffAvailable = isActionableWorkspaceDiffValue(diffValue);
          const openPrimaryEvidence = () => onOpenArtifacts(gate.primaryArtifactPath ?? undefined);
          return (
            <View
              key={gate.decision.id}
              style={[styles.workspaceGateRailCard, { borderColor: tone + '66' }]}
            >
              <Pressable onPress={() => onOpenDecision(gate.decision.id)}>
                <View style={styles.workspaceGateRailCardHeader}>
                  <Text style={[styles.workspaceGateRailLabel, { color: tone }]}>{gate.label}</Text>
                  <Text style={styles.workspaceGateRailStatus}>
                    {gate.resolved ? 'resolved' : 'pending'}
                  </Text>
                </View>
                <Text style={styles.workspaceGateRailCardTitle} numberOfLines={2}>
                  {gate.title}
                </Text>
              </Pressable>
              <View style={styles.workspaceGateRailActions}>
                <RunGateAction
                  label="Gate"
                  value={gate.resolved ? 'resolved' : 'pending'}
                  onPress={() => onOpenDecision(gate.decision.id)}
                />
                <RunGateAction
                  label="Evidence"
                  value={String(gate.artifactPaths.length)}
                  onPress={openPrimaryEvidence}
                  disabled={gate.artifactPaths.length === 0}
                />
                <RunGateAction
                  label="Before→After"
                  value={String(comparePairCount)}
                  onPress={() => {
                    if (primaryVisualPair) onOpenArtifacts(primaryVisualPair.after.path);
                    else onOpenCompareTarget();
                  }}
                  disabled={comparePairCount === 0}
                />
                <RunGateAction
                  label="Diff"
                  value={diffValue ?? '-'}
                  onPress={onOpenDiff}
                  disabled={!diffAvailable}
                />
              </View>
              <View style={styles.workspaceGateRailMetrics}>
                {gate.metrics.slice(0, 2).map((metric) => (
                  <Text
                    key={`${gate.decision.id}:${metric.label}`}
                    style={styles.workspaceGateRailMetric}
                    numberOfLines={1}
                  >
                    {metric.label}: {metric.value}
                  </Text>
                ))}
              </View>
              {primaryVisualPair ? (
                <BeforeAfterPreview
                  pair={primaryVisualPair}
                  authHeaders={artifactAuthHeaders}
                  onOpenArtifact={onOpenArtifacts}
                  eyebrow={gate.label}
                  title="Gate before → after"
                  hint="Tap to inspect"
                  imageHeight={58}
                />
              ) : null}
              {fallbackVisualPair ? (
                <BeforeAfterPreview
                  pair={fallbackVisualPair}
                  authHeaders={artifactAuthHeaders}
                  onOpenArtifact={onOpenCompareFallbackArtifact}
                  eyebrow={compareFallbackPairIsRecipe ? 'Recipe compare' : 'Run compare'}
                  title={
                    compareFallbackPairIsRecipe
                      ? 'Recipe before → after fallback'
                      : 'Run before → after fallback'
                  }
                  hint="Gate has no visual pair"
                  imageHeight={58}
                />
              ) : null}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}
export function RunGateAction({
  label,
  value,
  onPress,
  disabled,
}: {
  label: string;
  value: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      style={[styles.workspaceGateRailAction, disabled && styles.cockpitTileDisabled]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={styles.workspaceGateRailActionLabel}>{label}</Text>
      <Text style={styles.workspaceGateRailActionValue} numberOfLines={1}>
        {value}
      </Text>
    </Pressable>
  );
}
export function RunBeforeAfterPriorityPanel({
  pair,
  pairCount,
  authHeaders,
  artifactCount,
  recipeArtifactCount,
  recipeAvailable,
  diffValue,
  slotId,
  eyebrow = 'Review first',
  title = 'Run before → after evidence',
  copy = 'Confirm the visible change before using retry, review, or recipe controls.',
  onOpenArtifact,
  onOpenCompare,
  onOpenArtifacts,
  onOpenRecipe,
  onOpenDiff,
  onOpenSlot,
  onOpenTerminal,
}: {
  pair: VisualArtifactPair;
  pairCount: number;
  authHeaders: ArtifactHttpHeaders;
  artifactCount: number;
  recipeArtifactCount: number | null;
  recipeAvailable?: boolean;
  diffValue: string;
  slotId?: string | null;
  eyebrow?: string;
  title?: string;
  copy?: string;
  onOpenArtifact: (artifactPath: string) => void;
  onOpenCompare: () => void;
  onOpenArtifacts: () => void;
  onOpenRecipe: () => void;
  onOpenDiff: () => void;
  onOpenSlot: () => void | undefined;
  onOpenTerminal: () => void | undefined;
}) {
  return (
    <View style={styles.runBeforeAfterPriorityPanel}>
      <BeforeAfterPreview
        pair={pair}
        authHeaders={authHeaders}
        onOpenArtifact={onOpenArtifact}
        eyebrow={eyebrow}
        title={title}
        hint={`${pairCount} pair${pairCount === 1 ? '' : 's'}`}
        imageHeight={88}
      />
      <View style={styles.runBeforeAfterPriorityActions}>
        <Text style={styles.runBeforeAfterPriorityCopy}>{copy}</Text>
        <Pressable style={styles.runBeforeAfterPriorityButton} onPress={onOpenCompare}>
          <Text style={styles.runBeforeAfterPriorityButtonText}>Compare evidence</Text>
        </Pressable>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.runBeforeAfterPriorityRail}
      >
        <CockpitTile label="Evidence" value={String(artifactCount)} onPress={onOpenArtifacts} />
        <CockpitTile
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
        <CockpitTile label="Diff" value={diffValue} onPress={onOpenDiff} />
        <CockpitTile label="Slot" value={slotId ?? '-'} onPress={onOpenSlot} disabled={!slotId} />
        <CockpitTile
          label="Terminal"
          value={slotId ? 'live' : '-'}
          onPress={onOpenTerminal}
          disabled={!slotId}
        />
      </ScrollView>
    </View>
  );
}
export function workspaceGateToneColor(gate: SlotWorkspaceGateSummary): string {
  if (gate.tone === 'ready') return colors.statusOk;
  if (gate.tone === 'warning') return colors.statusWarn;
  return colors.accent;
}
export function RunWorkspaceCockpit({
  diffValue,
  diffAvailable,
  manifestCount,
  recipeArtifactCount,
  recipeAvailable,
  recipeScopeLabel,
  familyId,
  gateCount,
  readyGate,
  reviewGate,
  retroSummary,
  visualPairCount,
  pendingCount,
  terminalAvailable,
  slotId,
  prNumber,
  onOpenTerminal,
  onOpenSlot,
  onOpenPR,
  onOpenArtifacts,
  onOpenCompare,
  onOpenRecipe,
  onOpenDiff,
  onOpenFamily,
  onOpenFamilyRetros,
  onOpenGate,
  onOpenRetro,
}: {
  diffValue: string;
  diffAvailable: boolean;
  manifestCount: number;
  recipeArtifactCount: number | null;
  recipeAvailable?: boolean;
  recipeScopeLabel: ReturnType<typeof recipeWorkspaceScopeLabel>;
  familyId: string | null | undefined;
  gateCount: number;
  readyGate: SlotWorkspaceGateSummary | null;
  reviewGate: SlotWorkspaceGateSummary | null;
  retroSummary: SlotWorkspaceRetroSummary | null;
  visualPairCount: number;
  pendingCount: number;
  terminalAvailable: boolean;
  slotId: string | null | undefined;
  prNumber: number | null | undefined;
  onOpenTerminal: () => void | undefined;
  onOpenSlot: () => void | undefined;
  onOpenPR: () => void;
  onOpenArtifacts: () => void;
  onOpenCompare: () => void;
  onOpenRecipe: () => void;
  onOpenDiff: () => void;
  onOpenFamily: () => void | undefined;
  onOpenFamilyRetros: () => void | undefined;
  onOpenGate: (gate: SlotWorkspaceGateSummary) => void;
  onOpenRetro: (retro: SlotWorkspaceRetroSummary) => void;
}) {
  return (
    <View style={styles.cockpitPanel}>
      <View style={styles.cockpitHeader}>
        <View>
          <Text style={styles.cockpitTitle}>Workspace cockpit</Text>
          <Text style={styles.cockpitMeta}>
            {gateCount} gate{gateCount === 1 ? '' : 's'} · {pendingCount} pending
          </Text>
        </View>
        <Pressable
          style={[styles.cockpitTerminalButton, !terminalAvailable && styles.cockpitTileDisabled]}
          onPress={onOpenTerminal}
          disabled={!terminalAvailable}
        >
          <Text style={styles.cockpitTerminalText}>Terminal</Text>
        </Pressable>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.cockpitRail}
      >
        <CockpitTile label="Slot" value={slotId ?? '-'} onPress={onOpenSlot} disabled={!slotId} />
        <CockpitTile
          label="PR"
          value={prNumber ? `#${prNumber}` : '-'}
          onPress={onOpenPR}
          disabled={!prNumber}
        />
        <CockpitTile
          label="Ready"
          value={readyGate ? runGateStateLabel(readyGate) : '-'}
          hint={readyGate ? runGateCockpitHint(readyGate) : undefined}
          onPress={() => {
            if (readyGate) onOpenGate(readyGate);
          }}
          disabled={!readyGate}
        />
        <CockpitTile
          label="Review gate"
          value={reviewGate ? runGateStateLabel(reviewGate) : '-'}
          hint={reviewGate ? runGateCockpitHint(reviewGate) : undefined}
          onPress={() => {
            if (reviewGate) onOpenGate(reviewGate);
          }}
          disabled={!reviewGate}
        />
        <CockpitTile
          label="Retro gate"
          value={retroSummary?.statusLabel ?? '-'}
          hint={retroSummary ? runRetroCockpitHint(retroSummary) : undefined}
          onPress={() => {
            if (retroSummary) onOpenRetro(retroSummary);
          }}
          disabled={!retroSummary}
        />
        <CockpitTile
          label="Family retros"
          value={familyId ? 'open' : '-'}
          onPress={onOpenFamilyRetros}
          disabled={!familyId}
        />
        <CockpitTile
          label="Artifact files"
          value={String(manifestCount)}
          onPress={onOpenArtifacts}
        />
        <CockpitTile
          label="Before→After"
          value={String(visualPairCount)}
          onPress={onOpenCompare}
          disabled={visualPairCount === 0}
        />
        <CockpitTile
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
          disabled={recipeAvailable === false}
        />
        <CockpitTile
          label="Diff view"
          value={diffAvailable ? diffValue : slotId ? 'workspace' : 'no diff'}
          onPress={onOpenDiff}
          disabled={!diffAvailable && !slotId}
        />
        <CockpitTile
          label="Family"
          value={shortId(familyId)}
          onPress={onOpenFamily}
          disabled={!familyId}
        />
      </ScrollView>
    </View>
  );
}
export function runGateStateLabel(gate: SlotWorkspaceGateSummary): string {
  if (!gate.resolved) return 'pending';
  if (gate.tone === 'ready') return 'ready';
  if (gate.tone === 'warning') return 'warning';
  return 'resolved';
}
export function runGateCockpitHint(gate: SlotWorkspaceGateSummary): string {
  const diffValue = workspaceGateDiffMetricValue(gate);
  const artifactLabel = `${gate.artifactPaths.length} file${
    gate.artifactPaths.length === 1 ? '' : 's'
  }`;
  return diffValue ? `${artifactLabel} · ${diffValue}` : artifactLabel;
}
export function runRetroCockpitHint(retro: SlotWorkspaceRetroSummary): string {
  const fileLabel = `${retro.artifactPaths.length} file${
    retro.artifactPaths.length === 1 ? '' : 's'
  }`;
  if (retro.visualPairCount === 0) return fileLabel;
  return `${fileLabel} · ${retro.visualPairCount} before→after`;
}
export function CockpitTile({
  label,
  value,
  onPress,
  disabled,
  hint,
}: {
  label: string;
  value: string;
  onPress: () => void | undefined;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <Pressable
      style={[styles.cockpitTile, disabled && styles.cockpitTileDisabled]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={styles.cockpitTileLabel}>{label}</Text>
      <Text style={styles.cockpitTileValue} numberOfLines={1}>
        {value}
      </Text>
      {hint ? (
        <Text style={styles.cockpitTileHint} numberOfLines={1}>
          {hint}
        </Text>
      ) : null}
    </Pressable>
  );
}
export function StepMeta({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <View style={styles.stepMetaItem}>
      <Text style={styles.stepMetaLabel}>{label}</Text>
      <Text style={[styles.stepMetaValue, tone ? { color: tone } : undefined]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}
type StructuredField = { label: string; value: string };

function humanizeFieldPart(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/[_-]+/gu, ' ')
    .replace(/^./u, (character) => character.toUpperCase());
}

function structuredValue(value: unknown): string | null {
  if (value === null) return 'None';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value) && value.every((item) => item == null || typeof item !== 'object')) {
    return value.map((item) => structuredValue(item) ?? '').join(', ') || 'None';
  }
  return null;
}

function flattenStructuredFields(
  value: unknown,
  path: string[] = [],
  fields: StructuredField[] = [],
): StructuredField[] {
  const scalar = structuredValue(value);
  if (scalar !== null) {
    fields.push({
      label: path.length ? path.map(humanizeFieldPart).join(' · ') : 'Value',
      value: scalar,
    });
    return fields;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      flattenStructuredFields(item, [...path, `Item ${index + 1}`], fields),
    );
    return fields;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      fields.push({ label: path.map(humanizeFieldPart).join(' · ') || 'Value', value: 'None' });
    } else {
      entries.forEach(([key, child]) => flattenStructuredFields(child, [...path, key], fields));
    }
  }
  return fields;
}

export function StructuredDataBlock({
  title,
  value,
}: {
  title: string;
  value: Record<string, unknown>;
}) {
  const allFields = flattenStructuredFields(value);
  const fields = allFields.slice(0, 32);
  const hiddenFieldCount = allFields.length - fields.length;
  return (
    <View style={styles.stepBlock}>
      <Text style={styles.stepBlockTitle}>{title}</Text>
      <View style={styles.stepFieldList}>
        {fields.map((field, index) => (
          <View key={`${field.label}-${index}`} style={styles.stepFieldRow}>
            <Text style={styles.stepFieldLabel}>{field.label}</Text>
            <Text style={styles.stepFieldValue} selectable>
              {field.value}
            </Text>
          </View>
        ))}
        {hiddenFieldCount > 0 ? (
          <Text style={styles.stepFieldOverflow}>+{hiddenFieldCount} more fields</Text>
        ) : null}
      </View>
    </View>
  );
}
export function stepIcon(status: RunStep['status']): string {
  if (status === 'done') return '✓';
  if (status === 'running') return '▶';
  if (status === 'failed') return '✗';
  if (status === 'skipped') return '↷';
  return '○';
}
export function stepStatusColor(status: RunStep['status']): string {
  if (status === 'done') return colors.statusOk;
  if (status === 'running') return colors.statusWarn;
  if (status === 'failed') return colors.statusFail;
  if (status === 'skipped') return colors.textMuted;
  return colors.accent;
}
export function formatTimestamp(value: string | undefined): string {
  if (!value) return '-';
  return new Date(value).toLocaleTimeString();
}
export function collectStepArtifacts(step: RunStep): string[] {
  const artifacts = new Set<string>();
  collectArtifactStrings(step.outputs, artifacts);
  return [...artifacts];
}
const STEP_ARTIFACT_PREVIEW_LIMIT = 24;
export function collectArtifactStrings(value: unknown, artifacts: Set<string>) {
  // Preview cap keeps deeply nested step outputs bounded; add an expand affordance
  // if real step outputs routinely exceed this limit.
  if (!value || artifacts.size >= STEP_ARTIFACT_PREVIEW_LIMIT) return;
  if (typeof value === 'string') {
    if (
      /(\.png|\.jpe?g|\.webp|\.gif|\.mp4|\.mov|\.webm|\.md|\.json|\.txt|\.diff|\.patch)$/i.test(
        value,
      )
    ) {
      artifacts.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectArtifactStrings(item, artifacts));
    return;
  }
  if (typeof value === 'object') {
    Object.values(value).forEach((item) => collectArtifactStrings(item, artifacts));
  }
}
export function shortId(value: string | null | undefined): string {
  if (!value) return '-';
  return value.length > 10 ? `${value.slice(0, 8)}…` : value;
}
export function routeParamString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}
export function decisionPresentationForRun(run: Run, decision: RunDecision): DecisionPresentation {
  return presentDecision({
    ...decision,
    slotId: run.slotId,
    context: {
      ...(decision.context ?? {}),
      runId: run.id,
      familyId: run.familyId,
      ticketOrPr: run.ticketOrPr,
      slotId: run.slotId,
      project: run.project,
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
  });
}
export function DecisionSummaryCard({
  presentation,
  resolvedAction,
  resolvedAt,
  onPress,
  onOpenArtifacts,
  onOpenDiff,
  onOpenCompare,
}: {
  presentation: DecisionPresentation;
  resolvedAction?: string;
  resolvedAt?: string;
  onPress: () => void;
  onOpenArtifacts: () => void;
  onOpenDiff: () => void;
  onOpenCompare: (artifactPath?: string) => void;
}) {
  const resolved = Boolean(resolvedAt);
  const tone = TONE_COLORS[resolved ? 'ok' : presentation.tone];
  const reviewLabel = presentation.kind === 'retrospective' ? 'Open retro' : 'Open review';
  const summary = presentation.summary || presentation.description;
  const statusText = resolved
    ? `Action: ${resolvedAction ?? 'resolved'}`
    : presentation.kind === 'retrospective'
      ? 'Pending retrospective review'
      : 'Pending operator review';
  const visualPairSummary = groupVisualArtifactPairs(
    presentation.artifactManifest,
    (artifact) => artifact.path,
  );
  const primaryVisualPair = visualPairSummary.pairs[0] ?? null;
  return (
    <Pressable style={[styles.decisionCard, { borderLeftColor: tone }]} onPress={onPress}>
      <View style={styles.row}>
        <View style={[styles.decisionTypeBadge, { backgroundColor: tone + '22' }]}>
          <Text style={[styles.decisionTypeText, { color: tone }]}>
            {resolved ? 'Resolved' : presentation.kindLabel}
          </Text>
        </View>
        <Text style={styles.decisionOpenText}>{reviewLabel}</Text>
      </View>
      <Text style={styles.decisionTitle}>{presentation.title}</Text>
      <Text style={styles.decisionSummaryText} numberOfLines={3}>
        {summary}
      </Text>
      {presentation.highlights.length > 0 ? (
        <View style={styles.decisionSignalRow}>
          {presentation.highlights.slice(0, 4).map((item) => {
            const signalTone = TONE_COLORS[item.tone ?? 'info'];
            const target = workspaceSignalTargetForDecisionLabel(item.label);
            const content = (
              <>
                <Text style={[styles.decisionSignalLabel, { color: signalTone }]}>
                  {item.label}
                </Text>
                <Text style={styles.decisionSignalValue} numberOfLines={1}>
                  {item.value}
                  {target ? ' ›' : ''}
                </Text>
              </>
            );
            return target ? (
              <Pressable
                key={`${presentation.id}:${item.label}:${item.value}`}
                style={[styles.decisionSignalChip, { borderColor: signalTone + '66' }]}
                onPress={
                  target === 'diff'
                    ? onOpenDiff
                    : target === 'compare'
                      ? () => onOpenCompare(primaryVisualPair?.after.path)
                      : onOpenArtifacts
                }
              >
                {content}
              </Pressable>
            ) : (
              <View
                key={`${presentation.id}:${item.label}:${item.value}`}
                style={[styles.decisionSignalChip, { borderColor: signalTone + '66' }]}
              >
                {content}
              </View>
            );
          })}
        </View>
      ) : null}
      <Text style={baseStyles.textMuted}>{statusText}</Text>
    </Pressable>
  );
}
export function MetricItem({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metricItem}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  );
}
