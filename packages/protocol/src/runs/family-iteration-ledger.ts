import type {
  FamilyChangeLedgerEntry,
  FamilyObservabilityRunSummary,
  FamilyObservabilitySnapshot,
} from '../contracts/index.js';

export interface FamilyIterationLedgerCard {
  index: number;
  runId: string;
  parentRunId?: string | null;
  shortRunId: string;
  flowType: FamilyChangeLedgerEntry['flowType'];
  flowLabel: string;
  reason: string;
  title: string;
  diffLabel: string;
  reviewedInputLabel: string;
  evidenceLabel: string;
  recipeLabel: string;
  reviewLabel: string;
  ciLabel: string;
  missingLabel: string;
  prLabel: string;
  slotLabel: string;
  createdAt: string;
}

export interface FamilyIterationLedgerPresentation {
  cards: FamilyIterationLedgerCard[];
  summary: {
    totalRuns: number;
    producedDiffRuns: number;
    reviewedInputRuns: number;
    recipeRuns: number;
    evidenceRuns: number;
    ciIssueRuns: number;
    missingRuns: number;
  };
}

export function buildFamilyIterationLedgerPresentation(
  snapshot: Pick<FamilyObservabilitySnapshot, 'runs' | 'familyChangeLedger'>,
): FamilyIterationLedgerPresentation {
  const ledgerEntries = snapshot.familyChangeLedger?.entries ?? [];
  const runsById = new Map(snapshot.runs.map((run) => [run.runId, run]));
  const sourceEntries =
    ledgerEntries.length > 0 ? ledgerEntries : snapshot.runs.map(fallbackLedgerEntryForRun);
  const orderedEntries = [...sourceEntries].sort(compareIterations);
  const cards = orderedEntries.map((entry, index) =>
    buildFamilyIterationCard(entry, runsById.get(entry.runId), index),
  );
  return {
    cards,
    summary: {
      totalRuns: cards.length,
      producedDiffRuns: cards.filter((card) => card.diffLabel !== 'no code delta').length,
      reviewedInputRuns: cards.filter((card) => card.reviewedInputLabel !== 'no reviewed input')
        .length,
      recipeRuns: cards.filter((card) => card.recipeLabel !== 'recipe not captured').length,
      evidenceRuns: cards.filter((card) => !card.evidenceLabel.startsWith('no evidence')).length,
      ciIssueRuns: cards.filter((card) => card.ciLabel !== 'no CI issue captured').length,
      missingRuns: cards.filter((card) => card.missingLabel !== 'complete').length,
    },
  };
}

function buildFamilyIterationCard(
  entry: FamilyChangeLedgerEntry,
  run: FamilyObservabilityRunSummary | undefined,
  index: number,
): FamilyIterationLedgerCard {
  return {
    index: index + 1,
    runId: entry.runId,
    parentRunId: entry.parentRunId,
    shortRunId: entry.runId.slice(0, 8),
    flowType: entry.flowType,
    flowLabel: flowTypeLabel(entry.flowType),
    reason: iterationReason(entry, run),
    title: run?.summary?.trim() || entry.ticketOrPr || entry.familyRootTicketOrPr,
    diffLabel: contributionDiffLabel(entry),
    reviewedInputLabel: reviewedInputLabel(entry),
    evidenceLabel: evidenceLabel(entry, run),
    recipeLabel: recipeLabel(run),
    reviewLabel: reviewLabel(entry),
    ciLabel: ciLabel(run),
    missingLabel: entry.missingData.length > 0 ? entry.missingData.join(', ') : 'complete',
    prLabel: entry.prNumber ? `PR #${entry.prNumber}` : entry.lane,
    slotLabel: run?.slotId ?? 'slot unknown',
    createdAt: entry.createdAt,
  };
}

function compareIterations(a: FamilyChangeLedgerEntry, b: FamilyChangeLedgerEntry): number {
  if (!a.parentRunId && b.parentRunId) return -1;
  if (a.parentRunId && !b.parentRunId) return 1;
  const createdDelta = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (Number.isFinite(createdDelta) && createdDelta !== 0) return createdDelta;
  return a.runId.localeCompare(b.runId);
}

function flowTypeLabel(flowType: FamilyChangeLedgerEntry['flowType']): string {
  switch (flowType) {
    case 'fix-bug':
      return 'Fix bug';
    case 'review-pr':
      return 'Review PR';
    case 'dev':
      return 'Dev';
    case 'pr-complete':
      return 'PR complete';
    case 'merge-main':
      return 'Merge main';
    default:
      return flowType;
  }
}

function iterationReason(
  entry: FamilyChangeLedgerEntry,
  run: FamilyObservabilityRunSummary | undefined,
): string {
  if (!entry.parentRunId) {
    return entry.flowType === 'review-pr'
      ? 'Initial PR review input'
      : 'Original task implementation';
  }
  if (entry.flowType === 'pr-complete') {
    const bot = entry.reviewSignals?.botAddressed ?? 0;
    const human = entry.reviewSignals?.humanCommentsAddressed ?? 0;
    if (bot > 0 && human > 0) return 'Follow-up for bot and human review feedback';
    if (bot > 0) return 'Follow-up for bot review feedback';
    if (human > 0) return 'Follow-up for human review feedback';
    if (hasCiIssue(run)) return 'Follow-up for CI failure';
    if (entry.inputDiff?.available) return 'Follow-up after reviewed PR input changed';
    return 'PR completion follow-up';
  }
  if (entry.flowType === 'review-pr') return 'Independent review iteration';
  if (hasCiIssue(run)) return 'Follow-up for CI failure';
  if (entry.contributionDiff.available) return 'Follow-up code iteration';
  return 'Family follow-up iteration';
}

function contributionDiffLabel(entry: FamilyChangeLedgerEntry): string {
  const diff = entry.contributionDiff.available
    ? entry.contributionDiff
    : entry.legacyDiffFallback?.available
      ? entry.legacyDiffFallback
      : null;
  if (!diff) return 'no code delta';
  return `${diff.files} files · +${diff.additions} -${diff.deletions}`;
}

function reviewedInputLabel(entry: FamilyChangeLedgerEntry): string {
  if (!entry.inputDiff) return 'no reviewed input';
  if (entry.inputDiff.available) {
    return `${entry.inputDiff.files} files · +${entry.inputDiff.additions} -${entry.inputDiff.deletions}`;
  }
  return entry.inputDiff.missingReason === 'no-source-diff'
    ? 'reviewed input had no source diff'
    : 'reviewed input unavailable';
}

function evidenceLabel(
  entry: FamilyChangeLedgerEntry,
  run: FamilyObservabilityRunSummary | undefined,
): string {
  const count = run?.artifacts.length ?? entry.artifactFootprint.count;
  if (count === 0) return 'no evidence captured';
  const size =
    entry.artifactFootprint.bytes > 0 ? `${formatCompactBytes(entry.artifactFootprint.bytes)}` : '';
  return size ? `${count} files · ${size}` : `${count} files`;
}

function recipeLabel(run: FamilyObservabilityRunSummary | undefined): string {
  if (!run) return 'recipe not captured';
  if (run.recipeQuality.source !== 'missing') {
    const score = run.recipeQuality.score == null ? '' : ` · ${run.recipeQuality.score}`;
    return `${run.recipeQuality.semantic}${score}`;
  }
  if (run.recipeJson || run.recipeProvenance || run.recipeQualityArtifact) return 'recipe captured';
  return 'recipe not captured';
}

function reviewLabel(entry: FamilyChangeLedgerEntry): string {
  const signals = entry.reviewSignals;
  if (!signals) return 'no review signals';
  const parts = [
    signals.botAddressed > 0 ? `bot ${signals.botAddressed}` : '',
    signals.humanCommentsAddressed > 0 ? `human ${signals.humanCommentsAddressed}` : '',
    signals.humanReviewersRequestingChanges > 0
      ? `${signals.humanReviewersRequestingChanges} reviewer${signals.humanReviewersRequestingChanges === 1 ? '' : 's'} requested changes`
      : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : 'review checked';
}

function ciLabel(run: FamilyObservabilityRunSummary | undefined): string {
  if (!run) return 'no CI issue captured';
  const failedChecks = run.ciChecks.filter((check) =>
    ['failure', 'cancelled', 'timed_out', 'action_required'].includes(check.conclusion ?? ''),
  );
  const ciDecisions =
    run.decisions?.filter((decision) => decision.type.toLowerCase().includes('ci')) ?? [];
  if (failedChecks.length > 0 && ciDecisions.length > 0) {
    return `${failedChecks.length} failed check${failedChecks.length === 1 ? '' : 's'} · ${ciDecisions.length} CI decision${ciDecisions.length === 1 ? '' : 's'}`;
  }
  if (failedChecks.length > 0) {
    return `${failedChecks.length} failed check${failedChecks.length === 1 ? '' : 's'}`;
  }
  if (ciDecisions.length > 0) {
    return `${ciDecisions.length} CI decision${ciDecisions.length === 1 ? '' : 's'}`;
  }
  return 'no CI issue captured';
}

function hasCiIssue(run: FamilyObservabilityRunSummary | undefined): boolean {
  return ciLabel(run) !== 'no CI issue captured';
}

function formatCompactBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
}

function fallbackLedgerEntryForRun(run: FamilyObservabilityRunSummary): FamilyChangeLedgerEntry {
  return {
    runId: run.runId,
    familyId: run.familyId,
    parentRunId: run.parentRunId,
    familyRootTicketOrPr: run.ticketOrPr,
    lane: run.lane,
    variant: run.variant,
    flowType: run.flowType,
    project: run.project,
    ticketOrPr: run.ticketOrPr,
    branch: run.branch,
    prNumber: run.prNumber,
    createdAt: run.createdAt,
    completedAt: run.completedAt,
    changeKind: run.diffStat.available ? 'contribution' : 'none',
    contributionDiff: {
      source: run.diffStat.available ? 'artifact' : 'unavailable',
      kind: 'contribution',
      available: run.diffStat.available,
      files: run.diffStat.files,
      additions: run.diffStat.additions,
      deletions: run.diffStat.deletions,
      missingReason: run.diffStat.available ? undefined : 'missing-ledger',
    },
    artifactFootprint: {
      count: run.artifacts.length,
      bytes: run.artifacts.reduce((total, artifact) => total + (artifact.sizeBytes ?? 0), 0),
      byPurpose: [],
      bySource: [],
      byExtension: [],
    },
    taskInputArtifacts: [],
    missingData: run.missingData,
  };
}
