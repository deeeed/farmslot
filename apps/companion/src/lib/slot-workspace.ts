import type {
  RecipeRunArtifactGroup,
  Run,
  RunDecision,
  SlotRunHistoryEntry,
} from '@farmslot/protocol';

import {
  type ArtifactManifestEntry,
  artifactsForRecipeRun,
  classifyArtifact,
  countVisualArtifactPairs,
  CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
  DECISION_EVIDENCE_RECIPE_RUN_PARAM,
  extractRunArtifactManifest,
  groupVisualArtifactPairs,
  inferArtifactPurpose,
} from './artifact-url';

export interface SlotWorkspaceGateSummary {
  decision: RunDecision;
  label: string;
  title: string;
  summary: string;
  tone: 'ready' | 'review' | 'warning';
  resolved: boolean;
  primaryArtifactPath: string | null;
  artifactPaths: string[];
  metrics: Array<{ label: string; value: string }>;
}

export interface SlotWorkspaceRetroSummary {
  decision: RunDecision;
  title: string;
  summary: string;
  pending: boolean;
  statusLabel: string;
  primaryArtifactPath: string | null;
  artifactPaths: string[];
  visualPairCount: number;
  primaryVisualPair: SlotWorkspaceVisualPairSignal | null;
  metrics: Array<{ label: string; value: string }>;
}

export interface SlotWorkspaceVisualPairSignal {
  beforePath: string;
  afterPath: string;
  stem: string;
}

export interface SlotRecipeEvidenceGroupSummary {
  id: string;
  label: string;
  status: RecipeRunArtifactGroup['status'];
  artifactCount: number;
  promoted: boolean;
  isStale: boolean;
}

export interface SlotRecipeEvidenceSummary {
  totalRuns: number;
  totalArtifacts: number;
  passingRuns: number;
  failingRuns: number;
  staleRuns: number;
  groups: SlotRecipeEvidenceGroupSummary[];
}

export interface SlotWorkspaceRunFocus {
  label: 'Current slot run' | 'Historical run' | 'Selected run';
  isHistorical: boolean;
}

export interface SlotCompareTarget {
  artifactPath: string;
  recipeRunId: string | null;
  pairCount: number;
  source: 'selected-recipe' | 'run' | 'recipe-fallback';
}

export interface SlotHistoryRecipeWorkspaceTarget {
  recipeRunId?: string | null;
  artifactPath?: string | null;
}

export interface SlotHistoryCompareWorkspaceTarget {
  runPairCount?: number | null;
  runArtifactPath?: string | null;
  recipePairCount?: number | null;
  recipeRunId?: string | null;
  recipeArtifactPath?: string | null;
}

export type SlotWorkspaceGateFocus = 'ready' | 'review' | 'no-change' | null | undefined;

export function orderSlotWorkspaceGatesForFocus(
  gates: SlotWorkspaceGateSummary[],
  focus: SlotWorkspaceGateFocus,
): SlotWorkspaceGateSummary[] {
  const focusedKind = normalizedGateFocus(focus);
  if (!focusedKind) return gates;
  return [...gates].sort((left, right) => {
    const leftFocused = workspaceGateMatchesFocus(left, focusedKind);
    const rightFocused = workspaceGateMatchesFocus(right, focusedKind);
    if (leftFocused !== rightFocused) return leftFocused ? -1 : 1;
    return 0;
  });
}

export function slotHistoryRecipeWorkspaceParams(
  target: SlotHistoryRecipeWorkspaceTarget | null | undefined,
): { recipeRun: string; artifact?: string } {
  const recipeRun = nonEmpty(target?.recipeRunId) ?? CURRENT_ARTIFACTS_RECIPE_RUN_PARAM;
  const artifact = nonEmpty(target?.artifactPath);
  return artifact ? { recipeRun, artifact } : { recipeRun };
}

export function slotHistoryCompareWorkspaceParams(
  target: SlotHistoryCompareWorkspaceTarget | null | undefined,
): { recipeRun: string; artifact?: string } | null {
  const runPairCount = Math.max(0, target?.runPairCount ?? 0);
  const recipePairCount = Math.max(0, target?.recipePairCount ?? 0);
  if (runPairCount > 0) {
    const artifact = nonEmpty(target?.runArtifactPath);
    return artifact
      ? { recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM, artifact }
      : { recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM };
  }
  if (recipePairCount > 0) {
    return slotHistoryRecipeWorkspaceParams({
      recipeRunId: target?.recipeRunId,
      artifactPath: target?.recipeArtifactPath,
    });
  }
  return null;
}

export function selectSlotWorkspaceRunId({
  requestedRunId,
  currentRunId,
  history,
}: {
  requestedRunId: string | null | undefined;
  currentRunId: string | null | undefined;
  history: ReadonlyArray<Pick<SlotRunHistoryEntry, 'runId'>>;
}): string | null {
  return nonEmpty(requestedRunId) ?? nonEmpty(currentRunId) ?? nonEmpty(history[0]?.runId) ?? null;
}

export function describeSlotWorkspaceRunFocus({
  runId,
  currentRunId,
}: {
  runId: string;
  currentRunId: string | null | undefined;
}): SlotWorkspaceRunFocus {
  const normalizedCurrentRunId = nonEmpty(currentRunId);
  if (!normalizedCurrentRunId) return { label: 'Historical run', isHistorical: true };
  if (runId === normalizedCurrentRunId) return { label: 'Current slot run', isHistorical: false };
  return { label: 'Selected run', isHistorical: true };
}

export function summarizeSlotWorkspaceGate(run: Run): SlotWorkspaceGateSummary | null {
  return summarizeSlotWorkspaceGates(run)[0] ?? null;
}

export function summarizeSlotWorkspaceGates(run: Run): SlotWorkspaceGateSummary[] {
  const decisions = run.decisions ?? [];
  const workspaceKinds = ['ready', 'review', 'no-change'] as const;
  const selected: RunDecision[] = [];

  for (const kind of workspaceKinds) {
    const match = latestWorkspaceDecisionForKind(decisions, kind);
    if (match) selected.push(match);
  }

  if (selected.length === 0) {
    const fallback = decisions.find((decision) => !decision.resolvedAt) ?? null;
    if (fallback) selected.push(fallback);
  }

  return selected
    .sort(compareWorkspaceGatePriority)
    .map((decision) => summarizeSlotWorkspaceDecision(run, decision))
    .filter((summary): summary is SlotWorkspaceGateSummary => Boolean(summary));
}

export function summarizeSlotWorkspaceRetro(run: Run): SlotWorkspaceRetroSummary | null {
  const decision = latestRetrospectiveDecision(run.decisions ?? []);
  if (!decision) return null;
  const payload = decision.payload?.kind === 'retrospective' ? decision.payload : null;
  const artifacts = extractRunArtifactManifest(run);
  const artifactPaths = artifacts.map((artifact) => artifact.path);
  const visualPairSummary = groupVisualArtifactPairs(artifacts, () => '');
  const primaryVisualPair = visualPairSummary.pairs[0] ?? null;
  const commentSummary = payload?.commentsTriageSummary;
  const ci = payload?.ciWatch;
  return {
    decision,
    title: decision.title,
    summary:
      payload?.deltaLearnings ??
      payload?.workerLearnings ??
      payload?.selfReviewSummary ??
      payload?.reportExcerpt ??
      decision.description,
    pending: !decision.resolvedAt,
    statusLabel: decision.resolvedAt
      ? formatMetricValue(payload?.outcome ?? decision.resolvedAction ?? 'recorded')
      : 'pending',
    primaryArtifactPath: artifactPaths[0] ?? null,
    artifactPaths,
    visualPairCount: visualPairSummary.pairs.length,
    primaryVisualPair: primaryVisualPair
      ? {
          beforePath: primaryVisualPair.before.path,
          afterPath: primaryVisualPair.after.path,
          stem: primaryVisualPair.stem,
        }
      : null,
    metrics: [
      { label: 'Outcome', value: formatMetricValue(payload?.outcome ?? decision.resolvedAction) },
      {
        label: 'Comments',
        value: commentSummary ? `${commentSummary.fixed}/${commentSummary.real} fixed` : '-',
      },
      {
        label: 'CI',
        value: ci?.result ?? (ci?.total != null ? `${ci.passed ?? 0}/${ci.total}` : '-'),
      },
    ],
  };
}

export function runWorkspaceDiffValue(
  run: Run,
  gate: SlotWorkspaceGateSummary | null | undefined = summarizeSlotWorkspaceGate(run),
): string {
  const gateValue = normalizedDiffMetricValue(gate);
  if (gateValue) return gateValue;
  const diffStat = runStepDiffStat(run);
  if (!diffStat?.files) return '-';
  return `+${diffStat.additions ?? 0} -${diffStat.deletions ?? 0}`;
}

export function hasRunWorkspaceDiff(
  run: Run,
  gate?: SlotWorkspaceGateSummary | null | undefined,
): boolean {
  return runWorkspaceDiffValue(run, gate) !== '-';
}

export function workspaceGateDiffMetricValue(
  gate: Pick<SlotWorkspaceGateSummary, 'metrics'>,
): string | null {
  return gate.metrics.find((metric) => metric.label.trim().toLowerCase() === 'diff')?.value ?? null;
}

export function isActionableWorkspaceDiffValue(value: string | null | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return Boolean(
    normalized && normalized !== '-' && normalized !== 'none' && normalized !== 'no diff',
  );
}

function normalizedDiffMetricValue(
  gate: SlotWorkspaceGateSummary | null | undefined,
): string | null {
  const value = gate?.metrics.find((metric) => metric.label.toLowerCase() === 'diff')?.value;
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === '-' || normalized === 'none' || normalized === 'no diff') {
    return null;
  }
  return value;
}

function runStepDiffStat(
  run: Run,
): { additions?: number; deletions?: number; files?: number } | undefined {
  return (run.steps ?? [])
    .map((step) => step.outputs)
    .find(
      (
        output,
      ): output is { diffStat?: { additions?: number; deletions?: number; files?: number } } =>
        Boolean(
          output &&
          typeof output === 'object' &&
          !Array.isArray(output) &&
          'diffStat' in output &&
          (output as { diffStat?: unknown }).diffStat,
        ),
    )?.diffStat;
}

function summarizeSlotWorkspaceDecision(
  run: Run,
  decision: RunDecision,
): SlotWorkspaceGateSummary | null {
  const payload = decision.payload;
  const resolved = Boolean(decision.resolvedAt);
  const artifactPaths = artifactPathsForDecision(run, decision);
  const primaryArtifactPath = artifactPaths[0] ?? null;
  const visualPairMetric = beforeAfterMetricForArtifactPaths(run, artifactPaths);
  if (payload?.kind === 'ready') {
    const evidenceCount = extractRunArtifactManifest(run).length;
    const diff =
      payload.diffStat.files > 0
        ? `+${payload.diffStat.additions} -${payload.diffStat.deletions}`
        : 'none';
    return {
      decision,
      label: 'Ready workspace',
      title: decision.title,
      summary:
        payload.validationSummary ??
        payload.selfReviewSummary ??
        payload.workerReport ??
        decision.description,
      tone: 'ready',
      resolved,
      primaryArtifactPath,
      artifactPaths,
      metrics: [
        { label: 'Diff', value: diff },
        { label: 'Evidence', value: String(evidenceCount) },
        ...visualPairMetric,
        { label: 'Publish', value: formatMetricValue(payload.publicationStatus) },
      ],
    };
  }

  if (payload?.kind === 'review') {
    const evidenceCount =
      (payload.artifactManifest?.length ?? 0) + (payload.reviewInputArtifactPaths?.length ?? 0);
    return {
      decision,
      label: 'Review workspace',
      title: decision.title,
      summary: payload.evidenceMarkdown ?? payload.reviewMd ?? decision.description,
      tone: payload.recommendation === 'APPROVE' ? 'ready' : 'review',
      resolved,
      primaryArtifactPath,
      artifactPaths,
      metrics: [
        { label: 'Verdict', value: formatMetricValue(payload.recommendation) },
        { label: 'Comments', value: String(payload.lineComments.length) },
        { label: 'Evidence', value: String(evidenceCount) },
        ...visualPairMetric,
      ],
    };
  }

  if (payload?.kind === 'no-change') {
    const evidenceCount =
      payload.artifactManifest?.length ?? payload.evidence?.artifacts?.length ?? 0;
    return {
      decision,
      label: 'No-change review',
      title: decision.title,
      summary: payload.workerReport ?? payload.reason ?? decision.description,
      tone: payload.disposition === 'failed' ? 'warning' : 'review',
      resolved,
      primaryArtifactPath,
      artifactPaths,
      metrics: [
        { label: 'Disposition', value: formatMetricValue(payload.disposition) },
        { label: 'Evidence', value: String(evidenceCount) },
        ...visualPairMetric,
        { label: 'Confidence', value: formatMetricValue(payload.evidence?.confidence) },
      ],
    };
  }

  return {
    decision,
    label: 'Review workspace',
    title: decision.title,
    summary: decision.description,
    tone: 'review',
    resolved,
    primaryArtifactPath,
    artifactPaths,
    metrics: [
      { label: 'Type', value: decision.type },
      { label: 'Actions', value: String(decision.actions.length) },
    ],
  };
}

function beforeAfterMetricForArtifactPaths(
  run: Run,
  artifactPaths: string[],
): Array<{ label: string; value: string }> {
  const pairs = countVisualArtifactPairs(artifactsForPaths(run, artifactPaths));
  if (pairs === 0) return [];
  return [{ label: 'Before→After', value: `${pairs} pair${pairs === 1 ? '' : 's'}` }];
}

function artifactsForPaths(run: Run, artifactPaths: string[]): ArtifactManifestEntry[] {
  const manifest = extractRunArtifactManifest(run);
  const byPath = new Map(manifest.map((artifact) => [artifact.path, artifact] as const));
  return artifactPaths.map(
    (path) => byPath.get(path) ?? { path, purpose: inferArtifactPurpose(path) },
  );
}

function artifactPathsForDecision(run: Run, decision: RunDecision): string[] {
  const payload = decision.payload;
  if (!payload) return [];
  if (payload.kind === 'ready') {
    return uniqueArtifactPaths([
      ...manifestPaths(payload.artifactManifest),
      ...manifestPaths(extractRunArtifactManifest(run)),
    ]);
  }
  if (payload.kind === 'review') {
    return uniqueArtifactPaths([
      ...manifestPaths(payload.artifactManifest),
      ...(payload.reviewInputArtifactPaths ?? []),
    ]);
  }
  if (payload.kind === 'no-change') {
    return uniqueArtifactPaths([
      ...manifestPaths(payload.artifactManifest),
      ...(payload.evidence?.artifacts ?? []),
    ]);
  }
  return [];
}

function manifestPaths(manifest: ReadonlyArray<{ path: string }> | null | undefined): string[] {
  return (manifest ?? []).map((artifact) => artifact.path);
}

function uniqueArtifactPaths(paths: ReadonlyArray<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const normalized = path?.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function latestWorkspaceDecisionForKind(
  decisions: RunDecision[],
  kind: 'ready' | 'review' | 'no-change',
): RunDecision | null {
  const candidates = decisions
    .filter((decision) => decision.payload?.kind === kind)
    .sort(compareDecisionsNewestFirst);
  return candidates.find((decision) => !decision.resolvedAt) ?? candidates[0] ?? null;
}

function latestRetrospectiveDecision(decisions: RunDecision[]): RunDecision | null {
  const candidates = decisions
    .filter(
      (decision) => decision.payload?.kind === 'retrospective' || decision.type === 'retrospective',
    )
    .sort(compareDecisionsNewestFirst);
  return candidates.find((decision) => !decision.resolvedAt) ?? candidates[0] ?? null;
}

function compareWorkspaceGatePriority(left: RunDecision, right: RunDecision): number {
  const pendingDiff = Number(Boolean(left.resolvedAt)) - Number(Boolean(right.resolvedAt));
  if (pendingDiff !== 0) return pendingDiff;
  const kindDiff = workspaceKindPriority(left) - workspaceKindPriority(right);
  if (kindDiff !== 0) return kindDiff;
  return compareDecisionsNewestFirst(left, right);
}

function workspaceKindPriority(decision: RunDecision): number {
  if (decision.payload?.kind === 'ready') return 0;
  if (decision.payload?.kind === 'review') return 1;
  if (decision.payload?.kind === 'no-change') return 2;
  return 3;
}

function normalizedGateFocus(
  focus: SlotWorkspaceGateFocus,
): 'ready' | 'review' | 'no-change' | null {
  if (focus === 'ready') return 'ready';
  if (focus === 'review') return 'review';
  if (focus === 'no-change') return 'no-change';
  return null;
}

function workspaceGateMatchesFocus(
  gate: Pick<SlotWorkspaceGateSummary, 'decision' | 'label'>,
  focus: 'ready' | 'review' | 'no-change',
): boolean {
  if (gate.decision.payload?.kind === focus) return true;
  if (focus === 'review' && gate.label === 'Review workspace') return true;
  if (focus === 'no-change' && gate.label === 'No-change review') return true;
  return focus === 'ready' && gate.label === 'Ready workspace';
}

function compareDecisionsNewestFirst(left: RunDecision, right: RunDecision): number {
  return decisionTimestamp(right) - decisionTimestamp(left);
}

function decisionTimestamp(decision: RunDecision): number {
  const timestamp = Date.parse(decision.resolvedAt ?? decision.createdAt);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

export function summarizeSlotRecipeEvidence(
  recipeRuns: RecipeRunArtifactGroup[],
): SlotRecipeEvidenceSummary | null {
  if (recipeRuns.length === 0) return null;
  const groups = recipeRuns.map((group) => ({
    id: group.id,
    label: group.label,
    status: group.status,
    artifactCount: artifactsForRecipeRun(group).length,
    promoted: group.promoted,
    isStale: group.isStale,
  }));
  return {
    totalRuns: recipeRuns.length,
    totalArtifacts: groups.reduce((sum, group) => sum + group.artifactCount, 0),
    passingRuns: groups.filter((group) => group.status === 'pass').length,
    failingRuns: groups.filter((group) => group.status === 'fail').length,
    staleRuns: groups.filter((group) => group.isStale).length,
    groups,
  };
}

export function selectSlotRecipePreviewArtifacts(
  recipeRuns: RecipeRunArtifactGroup[],
  selectedRecipeRunId: string | null | undefined,
  limit = 4,
): ArtifactManifestEntry[] {
  const orderedGroups = [
    ...recipeRuns.filter((group) => group.id === selectedRecipeRunId),
    ...recipeRuns.filter((group) => group.id !== selectedRecipeRunId && group.promoted),
    ...recipeRuns.filter((group) => group.id !== selectedRecipeRunId && !group.promoted),
  ];
  const artifacts = orderedGroups.flatMap((group) => artifactsForRecipeRun(group));
  const visual = artifacts.filter((artifact) => {
    const kind = classifyArtifact(artifact);
    return kind === 'image' || kind === 'video';
  });
  const fallback = artifacts.filter((artifact) => !visual.includes(artifact));
  return [...visual, ...fallback].slice(0, limit);
}

export function selectSlotCompareTarget({
  runArtifacts,
  recipeRuns,
  selectedRecipeRunId,
}: {
  runArtifacts: ArtifactManifestEntry[];
  recipeRuns: RecipeRunArtifactGroup[];
  selectedRecipeRunId: string | null | undefined;
}): SlotCompareTarget | null {
  const selectedRecipeRun = recipeRuns.find((group) => group.id === selectedRecipeRunId) ?? null;
  const selectedRecipeArtifacts = selectedRecipeRun ? artifactsForRecipeRun(selectedRecipeRun) : [];
  const selectedRecipeTarget = compareTargetFromArtifacts(
    selectedRecipeArtifacts,
    'selected-recipe',
    selectedRecipeRun?.id ?? null,
  );
  if (selectedRecipeTarget) return selectedRecipeTarget;

  const runTarget = compareTargetFromArtifacts(runArtifacts, 'run', null);
  if (runTarget) return runTarget;

  const fallbackGroups = [
    ...recipeRuns.filter((group) => group.id !== selectedRecipeRunId && group.promoted),
    ...recipeRuns.filter((group) => group.id !== selectedRecipeRunId && !group.promoted),
  ];
  for (const group of fallbackGroups) {
    const target = compareTargetFromArtifacts(
      artifactsForRecipeRun(group),
      'recipe-fallback',
      group.id,
    );
    if (target) return target;
  }
  return null;
}

export function selectSlotRunEvidencePreviewArtifacts(
  artifacts: ArtifactManifestEntry[],
  limit = 4,
): ArtifactManifestEntry[] {
  const visual = artifacts.filter((artifact) => {
    const kind = classifyArtifact(artifact);
    return kind === 'image' || kind === 'video';
  });
  const fallback = artifacts.filter((artifact) => !visual.includes(artifact));
  return [...visual, ...fallback].slice(0, limit);
}

export function selectSlotGatePreviewArtifacts(
  gate: Pick<SlotWorkspaceGateSummary, 'artifactPaths'>,
  artifactManifest: ArtifactManifestEntry[],
  limit = 4,
): ArtifactManifestEntry[] {
  const byPath = new Map(artifactManifest.map((artifact) => [artifact.path, artifact] as const));
  return gate.artifactPaths
    .slice(0, limit)
    .map((path) => byPath.get(path) ?? { path, purpose: inferArtifactPurpose(path) });
}

export function selectSlotRecipeArtifactsForPreviewScope(
  recipeRuns: RecipeRunArtifactGroup[],
  selectedRecipeRunId: string | null | undefined,
): ArtifactManifestEntry[] {
  const selected = selectedRecipeRunId
    ? recipeRuns.find((group) => group.id === selectedRecipeRunId)
    : null;
  if (selected) return artifactsForRecipeRun(selected);
  const promoted = recipeRuns.find((group) => group.promoted);
  if (promoted) return artifactsForRecipeRun(promoted);
  return recipeRuns.flatMap((group) => artifactsForRecipeRun(group));
}

function compareTargetFromArtifacts(
  artifacts: ArtifactManifestEntry[],
  source: SlotCompareTarget['source'],
  fallbackRecipeRunId: string | null,
): SlotCompareTarget | null {
  const pairs = groupVisualArtifactPairs(artifacts, (artifact) => artifact.path).pairs;
  const primaryPair = pairs[0] ?? null;
  if (!primaryPair) return null;
  return {
    artifactPath: primaryPair.after.path,
    recipeRunId:
      primaryPair.after.recipeRunId ??
      primaryPair.before.recipeRunId ??
      fallbackRecipeRunId ??
      null,
    pairCount: pairs.length,
    source,
  };
}

function formatMetricValue(value: string | null | undefined): string {
  if (!value) return '-';
  return value.replace(/_/g, ' ');
}

function nonEmpty(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
