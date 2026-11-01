import {
  acceptanceCriteriaView,
  type AcceptanceCriterionRef,
  type AcceptanceCriterionView,
  type AcceptanceEvidenceLink,
  type AcceptanceStatusLedger,
  type AcceptanceStatusSummary,
  type ArtifactRef,
  type ClaimOverrideAuthority,
  delegatedVisualClaimAllowed,
  type DeterministicChecklistCheck,
  EVIDENCE_PADDING_MS,
  type EvidenceMomentRef,
  gateDisplayReasons,
  gateWaitReason,
  isRecipeRepairScope,
  isRecord,
  isTerminalRunStatus,
  normalizeRecipeClaimId,
  type OutputReviewPayload,
  projectClaimUntestableOverride,
  type RecipeClaimDeclaration,
  type RecipeClaimKind,
  type RecipeRecordingMarker,
  type RecipeRecordingTimelineBinding,
  type RecipeRecordingTimelineDocument,
  recipeTraceEntries,
  type RecipeVisualReviewAuthority,
  recordedEvidenceClosureIdentity,
  type RecordedEvidencePackageInput,
  recordedVisualJudgments,
  type RecordingSegmentRef,
  type ReviewDiffSnapshot,
  type ReviewRequirementDisplay,
  reviewRequirementDisplay,
  type ReviewStatus,
  type Run,
  type RunDecision,
  type RunGatePrerequisiteReason,
  type RunOutput,
  type RunReviewVisualClaimParams,
  type SelfPrincipalSummary,
  summarizeAcceptanceStatus,
  validateRecipeRecordingTimelineBinding,
  validVisualJudgmentReason,
} from '@farmslot/protocol';
import {
  deriveReviewedRecipeClaims,
  indexRecordingTimelines,
  occurrenceRecordingCoverage,
  planRecipeEvidence,
  proofDocument,
  recordedClaimSources,
  recordedSourceAuthority,
  selectedRecipeClaims,
  validateRecordedEvidencePackage,
} from '@farmslot/recipe-runner/evidence';

import {
  type EvidenceReviewComparisonFilter,
  type EvidenceReviewComparisonMedia,
  type EvidenceReviewComparisonRow,
  type EvidenceReviewComparisonTransform,
  matchesComparisonFilter,
  normalizedComparisonTransform,
  projectEvidenceComparisons,
} from './evidence-review-comparisons.js';
export type {
  EvidenceReviewComparisonFilter,
  EvidenceReviewComparisonMedia,
  EvidenceReviewComparisonRow,
  EvidenceReviewComparisonTransform,
} from './evidence-review-comparisons.js';

import {
  type EvidenceReviewPackageStatus,
  evidenceReviewPackageStatus,
  recipeRecordingLabel,
  REPLACED_RECORDING_MESSAGE,
} from './evidence-review-status.js';
import {
  type EvidenceReviewTimelineGroup,
  evidenceReviewTimelineGroups,
} from './evidence-review-timeline.js';

export type EvidenceReviewContext = 'gate' | 'pr-preview' | 'run-detail' | 'artifact';
export type EvidenceReviewTiming = 'measured' | 'untimed' | 'outside-recording';
export type EvidenceReviewMediaType = 'image' | 'video' | 'document';
export type EvidenceReviewProofKind = 'assertion' | 'agent-reviewed' | 'person-reviewed';

/** Standalone players supply the same retained trace and checked video identity. */
export interface EvidenceReviewRecordingInput extends RecipeRecordingTimelineBinding {
  timeline: RecipeRecordingTimelineDocument;
  gapBefore?: boolean;
}

export interface EvidenceReviewGateSnapshot {
  headSha?: string | null;
  reviewRequirement: ReviewRequirementDisplay;
  reviews: readonly Pick<
    ReviewStatus,
    'id' | 'mode' | 'verdict' | 'stale' | 'reviewedHeadSha' | 'reviewSnapshot'
  >[];
  ci: readonly DeterministicChecklistCheck[];
  ciChecks: NonNullable<import('@farmslot/protocol').ReadyGatePayload['ciChecks']>;
  ownReviewVerdict?: string;
  requirements: readonly RunGatePrerequisiteReason[];
  nextAction: string;
}

/** What a client offers on a criterion row: a proof player and the untestable override. */
export interface EvidenceReviewClaimOffers {
  playable?: boolean;
  overridable?: boolean;
}

export interface EvidenceReviewInput {
  visualReviewContext?: { snapshotIdentity: string; decisionId?: string };
  gateDecision?: RunDecision;
  artifacts?: readonly ArtifactRef[];
  comparisonSnapshot?: Pick<ReviewDiffSnapshot, 'baseSha' | 'headSha'>;
  criterionSourceUrl?: string;
  /** Gateway run contract: 0 is retained pre-cutover data, 1 is selected-attempt evidence. */
  contractVersion?: number;
  claimOverrideAuthority?: ClaimOverrideAuthority;
  visualReviewAuthority?: RecipeVisualReviewAuthority;
  context?: EvidenceReviewContext;
  readErrors?: readonly string[];
  /** From `runEvidencePending`: nothing is retained yet, so a missing package is not an error. */
  evidencePending?: boolean;
  /** Transport namespace; contract references stay relative to their recipe package. */
  artifactPrefix?: string;
  /** Display path relative to the run's artifacts; never used to resolve media. */
  packagePath?: string;
  package?: RecordedEvidencePackageInput;
  criteria?: readonly AcceptanceCriterionRef[];
  ledger?: AcceptanceStatusLedger | null;
  evidenceLinks?: readonly AcceptanceEvidenceLink[];
  recordings?: readonly EvidenceReviewRecordingInput[];
  report?: Pick<RunOutput, 'reportPath' | 'manifestDigest' | 'artifactManifest' | 'artifactBundle'>;
  reportSnapshot?: OutputReviewPayload;
}

export interface EvidenceReviewArtifact {
  path: string;
  /** Resolved transport path. Legacy task-ledger refs already live in that namespace. */
  artifactPath: string;
  name: string;
  mediaType: EvidenceReviewMediaType;
}

export interface EvidenceReviewArtifactPair<T> {
  before: T;
  after: T;
  claimId: string;
}

export interface EvidenceReviewClaim extends AcceptanceCriterionView {
  proofKinds: readonly EvidenceReviewProofKind[];
  reviewLabels: readonly string[];
  kind: RecipeClaimKind;
  parentId?: string;
  caption: string;
  timing?: EvidenceReviewTiming;
  evidence: readonly EvidenceReviewArtifact[];
  moments: readonly EvidenceMomentRef[];
  clips: readonly EvidenceReviewClip[];
  occurrences: readonly EvidenceReviewOccurrence[];
  /** Repair: older proof kept from its original execution and recorded revision. */
  retained?: { recipeRunId: string; revision?: string };
}

/** Qualified visual review only; assertions and worker notes are not pre-validation. */
export interface EvidenceReviewJudgmentRow {
  claim: EvidenceReviewClaim;
  pending: boolean;
  reviewKind: NonNullable<RunReviewVisualClaimParams['kind']> | null;
  prevalidation: {
    verdict: 'confirmed' | 'rejected';
    reason: string;
    reviewer: string;
    receiptId: string;
  } | null;
  media: EvidenceReviewClaimDisplay;
}

export interface EvidenceReviewOccurrence {
  traceIndex: number;
  nodeId: string;
  action: string;
  intent: string;
  ok: boolean;
  proves: readonly string[];
  /** Authored checked expectation from the retained input closure, not a fabricated result. */
  expectation?: Readonly<Record<string, unknown>>;
  artifacts: readonly EvidenceReviewArtifact[];
}

/** The recording AC verdicts come from: "Recording 07:26", and the newer one that replaced it. */
export interface EvidenceReviewRecording {
  label: string;
  replacedBy?: string;
}

/** One recorded execution's clip inputs: the fresh package or a retained original. */
interface ClipSource {
  segments: readonly RecordingSegmentRef[];
  timelines: ReadonlyMap<string, RecipeRecordingTimelineDocument>;
  recipeRunId?: string;
}

/** A virtual view of original media. Creating it performs no media I/O. */
export interface EvidenceReviewClip {
  videoPath: string;
  videoDigest: string;
  traceIndex: number;
  startMs: number;
  momentMs?: number;
  endMs: number;
  caption: string;
  moment?: EvidenceMomentRef;
}

export interface EvidenceReviewSelection {
  claimId?: string;
  traceIndex?: number;
  caption: string;
  timing: EvidenceReviewTiming;
  clips: readonly EvidenceReviewClip[];
  stills: readonly EvidenceReviewArtifact[];
  artifacts: readonly EvidenceReviewArtifact[];
  message?: string;
}

/** Renderers apply these effects to their existing player; range decisions stay here. */
export interface EvidenceReviewPlaybackEffect {
  clip: EvidenceReviewClip | null;
  seekMs: number | null;
  pause: boolean;
  sourceChanged: boolean;
}

export interface EvidenceReviewRecordingSelection {
  videoPath: string;
  mediaDurationMs?: number;
  phase?: 'start' | 'end';
}

export interface EvidenceReviewClaimDisplay {
  selected: readonly EvidenceReviewArtifact[];
  raw: readonly EvidenceReviewArtifact[];
  clip: EvidenceReviewClip | null;
}

export interface EvidenceReviewComparisonViewRow extends EvidenceReviewComparisonRow {
  primaryClip: EvidenceReviewClip | null;
  primaryFiles: readonly EvidenceReviewArtifact[];
}

export interface EvidenceReviewModel {
  readonly artifactInventory: readonly ArtifactRef[];
  claimDisplay(claimId: string): EvidenceReviewClaimDisplay;
  judgmentRows(principal: SelfPrincipalSummary | null): readonly EvidenceReviewJudgmentRow[];
  rawArtifacts<T extends { path: string }>(inventory: readonly T[]): readonly T[];
  artifactRole(path: string): 'before' | 'after' | 'review' | null;
  pairedArtifacts<T extends { path: string }>(
    artifacts: readonly T[],
  ): EvidenceReviewArtifactPair<T>[];
  readonly pendingVisualClaimIds: readonly string[];
  visualReviewKind(
    claimId: string,
    principal: SelfPrincipalSummary | null,
  ): NonNullable<RunReviewVisualClaimParams['kind']> | null;
  visualReviewRequest(
    claimId: string,
    principal: SelfPrincipalSummary | null,
    verdict: 'confirmed' | 'rejected',
    reason?: string,
  ): RunReviewVisualClaimParams;
  readonly gateSnapshot: EvidenceReviewGateSnapshot | null;
  readonly comparisons: readonly EvidenceReviewComparisonRow[];
  readonly unassigned: readonly EvidenceReviewComparisonMedia[];
  readonly comparisonErrors: readonly {
    code: 'comparison-source-mismatch';
    artifactPath: string;
    message: string;
  }[];
  readonly comparisonFilter: EvidenceReviewComparisonFilter;
  readonly comparisonTransform: EvidenceReviewComparisonTransform;
  readonly comparisonView: {
    rows: readonly EvidenceReviewComparisonViewRow[];
    unassigned: readonly EvidenceReviewComparisonMedia[];
  };
  setComparisonFilter(filter: EvidenceReviewComparisonFilter): void;
  chooseComparisonMedia(claimId: string, role: 'before' | 'after', identity: string): boolean;
  setComparisonTransform(transform: EvidenceReviewComparisonTransform): void;
  resetComparisonTransform(): void;
  selectComparisonMedia(identity: string): EvidenceReviewSelection | null;
  claimOverrideCandidate(
    id: string,
  ): Pick<import('@farmslot/protocol').RunOverrideClaimParams, 'claimId' | 'recipeRunId'> | null;
  /** Whether a criterion row has anything behind its "More" toggle; both clients ask this
   * instead of each listing the parts. */
  claimHasDetails(id: string, offers?: EvidenceReviewClaimOffers): boolean;
  /** The file a criterion's Review evidence opens: its selected proof, else its first evidence
   * file. None while the evidence is pending: a working run has retained nothing to open. */
  claimFocusPath(id: string): string | undefined;
  readonly context: EvidenceReviewContext;
  readonly summary: AcceptanceStatusSummary;
  readonly claims: readonly EvidenceReviewClaim[];
  readonly visualReviewMarkdown: string;
  readonly occurrences: readonly EvidenceReviewOccurrence[];
  /** `occurrences` for panel-level evidence details: empty when the package was replaced. */
  readonly currentOccurrences: readonly EvidenceReviewOccurrence[];
  readonly recordings: readonly RecipeRecordingTimelineDocument[];
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly displayWarnings: readonly string[];
  readonly selection: EvidenceReviewSelection | null;
  readonly playback: EvidenceReviewPlaybackEffect;
  readonly report: EvidenceReviewInput['report'];
  readonly packageStatus: EvidenceReviewPackageStatus | null;
  /** The recording the verdicts come from, and the one that replaced it, if any. */
  readonly recording: EvidenceReviewRecording | null;
  selectClaim(id: string, artifactPath?: string): EvidenceReviewSelection | null;
  selectOccurrence(
    traceIndex: number,
    recording?: EvidenceReviewRecordingSelection,
  ): EvidenceReviewSelection | null;
  timelineGroups(
    videoPath: string,
    claimId?: string,
    mediaDurationMs?: number,
  ): readonly EvidenceReviewTimelineGroup[];
  selectTimelineGroup(
    videoPath: string,
    groupId: string,
    mediaDurationMs?: number,
  ): EvidenceReviewPlaybackEffect;
  selectReport(): EvidenceReviewSelection | null;
  clearSelection(): void;
  artifactPath(path: string): string;
  cueClip(index: number): EvidenceReviewPlaybackEffect;
  seekClip(timeMs: number): EvidenceReviewPlaybackEffect;
  playbackAt(
    videoPath: string,
    timeMs: number,
    mediaDurationMs?: number,
  ): EvidenceReviewPlaybackEffect;
  markerSeekMs(
    videoPath: string,
    traceIndex: number,
    phase: 'start' | 'end',
    mediaDurationMs?: number,
  ): number | null;
  adjacentFrameMs(videoPath: string, timeMs: number, direction: -1 | 1): number | null;
  displayedFrameRangeMs(
    videoPath: string,
    timeMs: number,
    mediaDurationMs?: number,
  ): readonly [number, number] | null;
}

/** The worker is still working and the run has retained nothing, so there is no evidence
 * package to judge yet. Its verdicts show as reported; package checks wait for completion. */
export function runEvidencePending(
  run: Pick<Run, 'status' | 'artifactBundle' | 'output'>,
): boolean {
  return !isTerminalRunStatus(run.status) && !run.artifactBundle && !run.output?.artifactBundle;
}

/** Experimental ADR-062 projection shared by web and native review contexts. */
export function createEvidenceReviewModel(input: EvidenceReviewInput): EvidenceReviewModel {
  // Gate refreshes cannot mutate the already-validated selection. Inputs are protocol JSON.
  input = JSON.parse(JSON.stringify(input)) as EvidenceReviewInput;
  const pkg = input.package;
  const findings = pkg ? validateRecordedEvidencePackage(pkg).findings : [];
  // Invalid task-ledger input keeps its finding, without becoming recipe claims.
  const packageClaims = pkg?.claims?.schemaVersion === 2 ? pkg.claims : undefined;
  const errors = [
    ...(input.readErrors ?? []),
    ...findings.filter((finding) => finding.severity === 'error').map((finding) => finding.message),
  ];
  if (
    input.contractVersion !== undefined &&
    input.contractVersion !== 0 &&
    input.contractVersion !== 1
  )
    errors.push('The recorded run evidence contract is unsupported.');
  const warnings = findings
    .filter((finding) => finding.severity === 'warning')
    .map((finding) => finding.message);
  const reportWarning =
    input.report && !input.reportSnapshot
      ? 'This retained report has no recorded review binding.'
      : input.reportSnapshot &&
          (input.report?.manifestDigest !== input.reportSnapshot.manifestDigest ||
            input.report?.reportPath !== input.reportSnapshot.reportPath)
        ? 'The output report no longer matches the reviewed snapshot.'
        : undefined;
  if (reportWarning) warnings.push(reportWarning);
  if (
    packageClaims &&
    ['incomplete', 'failed', 'explicit-off'].includes(packageClaims.recording.status)
  )
    warnings.push(
      `Recording ${packageClaims.recording.status}: ${packageClaims.recording.reason ?? 'see retained capture status'}`,
    );
  const overrideAuthority =
    packageClaims &&
    input.claimOverrideAuthority &&
    errors.length === 0 &&
    pkg &&
    input.claimOverrideAuthority.recipeRunId === packageClaims.recipeRunId &&
    input.claimOverrideAuthority.closureIdentity === recordedEvidenceClosureIdentity(pkg)
      ? input.claimOverrideAuthority
      : undefined;
  const reviewed =
    packageClaims && pkg && errors.length === 0
      ? deriveReviewedRecipeClaims(pkg, input.visualReviewAuthority)
      : packageClaims?.criteria;
  // A repair selects each claim's source; retained originals keep their execution, media and receipts.
  const retainedSources = new Map(
    (pkg?.repair && packageClaims && errors.length === 0 ? recordedClaimSources(pkg) : []).flatMap(
      (source) =>
        source.artifactRoot
          ? [[source.claimId, { input: source.input, prefix: `${source.artifactRoot}/` }] as const]
          : [],
    ),
  );
  const retainedRevisions = new Map(
    pkg?.repair && isRecipeRepairScope(pkg.repair.scope)
      ? pkg.repair.scope.sources.map((source) => [source.recipeRunId, source.headSha] as const)
      : [],
  );
  const selectedRaw =
    packageClaims && pkg && errors.length === 0
      ? selectedRecipeClaims(pkg)
      : packageClaims?.criteria;
  const sourceAuthority = <T extends { recipeRunId: string; closureIdentity: string }>(
    authority: T | undefined,
    claimId: string,
  ): T | undefined => {
    const retained = retainedSources.get(normalizeRecipeClaimId(claimId));
    return retained && pkg ? recordedSourceAuthority(pkg, retained.input, authority) : authority;
  };
  const ledger = packageClaims
    ? {
        ...packageClaims,
        criteria: (reviewed ?? []).map((claim) => {
          const original = (selectedRaw ?? packageClaims.criteria).find(
            ({ id }) => id === claim.id,
          )!;
          const authority = sourceAuthority(overrideAuthority, claim.id);
          const override = authority
            ? projectClaimUntestableOverride(original, authority)
            : original;
          return override !== original ? override : claim;
        }),
      }
    : (input.ledger ?? null);
  if (input.ledger?.schemaVersion === 1 && !packageClaims) {
    warnings.push(
      'Legacy schema-1 task verdicts are retained display only; they establish no recorded recipe proof.',
    );
    if (input.contractVersion === 1 && !input.evidencePending)
      errors.push(
        'Current run evidence requires schema-2 engine claims and their selected execution package.',
      );
  }
  if (input.ledger?.schemaVersion === 2 && !pkg && !input.evidencePending)
    errors.push('Recorded claim evidence requires its retained execution package.');
  // The ledger follows the worker's latest recording; a package from another one was replaced.
  const replaced = Boolean(
    packageClaims &&
    input.ledger?.schemaVersion === 2 &&
    packageClaims.recipeRunId !== input.ledger.recipeRunId,
  );
  if (replaced) errors.push(REPLACED_RECORDING_MESSAGE);
  // The ledger's own recording: the first stamped evidence path of a criterion it judged itself.
  const ledgerRecording = input.ledger?.criteria
    .filter(({ inheritedFrom }) => !inheritedFrom)
    .flatMap(({ evidence }) => evidence ?? [])
    .map(recipeRecordingLabel)
    .find(Boolean);
  const packageRecording = recipeRecordingLabel(input.packagePath ?? input.artifactPrefix);
  const verdictRecording: EvidenceReviewRecording | null = replaced
    ? {
        label: packageRecording ?? 'Gate recording',
        replacedBy: ledgerRecording ?? 'a newer recording',
      }
    : (packageRecording ?? ledgerRecording)
      ? { label: (packageRecording ?? ledgerRecording)! }
      : null;
  const trace = recipeTraceEntries(pkg?.trace ?? input.recordings?.[0]?.trace) ?? [];
  const recordings: EvidenceReviewRecordingInput[] = pkg
    ? Object.values(pkg.timelines).map((timeline) => ({
        timeline,
        videoPath: timeline.videoPath,
        videoDigest: pkg.artifactDigests[timeline.videoPath] ?? '',
        trace: pkg.trace,
      }))
    : [...(input.recordings ?? [])];
  for (const recording of recordings) {
    if (pkg) continue; // The canonical package validator already checks every binding.
    errors.push(
      ...validateRecipeRecordingTimelineBinding(recording.timeline, { ...recording, trace })
        .findings.filter((finding) => finding.severity === 'error')
        .map((finding) => finding.message),
    );
  }
  const timelines = new Map(indexRecordingTimelines(recordings.map(({ timeline }) => timeline)));
  const segments: readonly RecordingSegmentRef[] =
    packageClaims?.recording.segments ??
    recordings.map((recording, index) => ({
      videoPath: recording.timeline.videoPath,
      videoDigest: recording.timeline.videoDigest,
      gapBefore: recording.gapBefore ?? index > 0,
    }));
  const recipeRunId =
    pkg && isRecord(pkg.summary) && typeof pkg.summary.recipeRunId === 'string'
      ? pkg.summary.recipeRunId
      : undefined;
  const manifest =
    pkg && isRecord(pkg.manifest) && Array.isArray(pkg.manifest.artifacts)
      ? pkg.manifest.artifacts.filter(isRecord)
      : [];
  const links = new Map((input.evidenceLinks ?? []).map((link) => [link.id, link.evidence]));
  const judgments =
    pkg && input.visualReviewAuthority && !errors.length
      ? [
          ...recordedVisualJudgments(pkg, input.visualReviewAuthority).filter(
            (judgment) => !retainedSources.has(normalizeRecipeClaimId(judgment.claimId)),
          ),
          ...[...retainedSources].flatMap(([claimId, retained]) => {
            const authority = sourceAuthority(input.visualReviewAuthority, claimId);
            return authority
              ? recordedVisualJudgments(retained.input, authority).filter(
                  (judgment) => normalizeRecipeClaimId(judgment.claimId) === claimId,
                )
              : [];
          }),
        ]
      : [];
  const latestJudgments = new Map(judgments.map((judgment) => [judgment.claimId, judgment]));
  function reviewContributions(id: string) {
    if (!latestJudgments.size) return [];
    const ids = new Set([id]);
    for (const claim of packageClaims?.criteria ?? []) {
      let parent = claim.parentId;
      while (parent) {
        if (parent === id) {
          ids.add(claim.id);
          break;
        }
        parent = packageClaims?.criteria.find((entry) => entry.id === parent)?.parentId;
      }
    }
    return [...ids].flatMap((claimId) => {
      const judgment = latestJudgments.get(claimId);
      const claim = selectedRaw?.find(({ id }) => id === claimId);
      return judgment && claim?.verdict === 'awaiting-review' ? [judgment] : [];
    });
  }
  const claims: EvidenceReviewClaim[] = acceptanceCriteriaView(
    packageClaims?.criteria ?? input.criteria ?? ledger?.criteria ?? [],
    ledger,
  ).map((claim) => ({
    ...claim,
    proofKinds: [
      ...new Set<EvidenceReviewProofKind>([
        ...(packageClaims && !errors.length && claim.status?.assertionIndices?.length
          ? ['assertion' as const]
          : []),
        ...reviewContributions(claim.id).map((judgment) =>
          judgment.kind !== 'person-reviewed'
            ? ('agent-reviewed' as const)
            : ('person-reviewed' as const),
        ),
      ]),
    ],
    reviewLabels: reviewContributions(claim.id).map(
      (judgment) =>
        `${judgment.kind === 'pipeline-reviewed' ? 'Verified by agent' : judgment.kind === 'lead-agent-reviewed' ? `agent-reviewed (delegated by ${judgment.delegation!.displayName})` : 'person-reviewed'} · ${judgment.reviewer.displayName}`,
    ),
    kind: claim.status?.kind ?? 'acceptance',
    ...(claim.status?.parentId ? { parentId: claim.status.parentId } : {}),
    caption: claimCaption(claim),
    timing: selectedRaw?.find((status) => status.id === claim.id)?.timing,
    ...(retainedSources.has(claim.id)
      ? {
          retained: {
            recipeRunId: retainedSources.get(claim.id)!.input.claims!.recipeRunId,
            ...(retainedRevisions.get(retainedSources.get(claim.id)!.input.claims!.recipeRunId)
              ? {
                  revision: retainedRevisions.get(
                    retainedSources.get(claim.id)!.input.claims!.recipeRunId,
                  ),
                }
              : {}),
          },
        }
      : {}),
    evidence: artifacts(
      claim.status?.evidence ?? links.get(claim.id) ?? [],
      packageClaims ? input.artifactPrefix : undefined,
    ),
    moments: claim.status?.moments ?? [],
    clips: [],
    occurrences: [],
  }));
  const proofNodes =
    pkg?.recipe && !errors.length
      ? planRecipeEvidence(
          proofDocument(pkg.recipe),
          new Map(
            isRecord(pkg.recipeResolution) && Array.isArray(pkg.recipeResolution.dependencies)
              ? pkg.recipeResolution.dependencies
                  .filter(isRecord)
                  .map((dependency) => [
                    String(dependency.ref),
                    proofDocument(pkg.resolvedRecipes?.[String(dependency.digest)]),
                  ])
              : [],
          ),
          pkg.invocation && isRecord(pkg.invocation)
            ? (pkg.invocation.claims as RecipeClaimDeclaration[] | undefined)
            : undefined,
        ).nodes
      : new Map();
  const nodeCounts = new Map<string, number>();
  for (const entry of trace) {
    if (isRecord(entry) && typeof entry.nodeId === 'string')
      nodeCounts.set(entry.nodeId, (nodeCounts.get(entry.nodeId) ?? 0) + 1);
  }
  const occurrences: EvidenceReviewOccurrence[] = trace.flatMap((entry, traceIndex) => {
    if (!isRecord(entry) || typeof entry.nodeId !== 'string') return [];
    const nodeId = entry.nodeId;
    const references = new Set(
      Array.isArray(entry.artifacts)
        ? entry.artifacts.filter(isRecord).map((artifact) => artifact.path)
        : [],
    );
    const files = manifest.filter((artifact) => {
      const source = isRecord(artifact.metadata) ? artifact.metadata.recordedEvidence : undefined;
      if (isRecord(source)) return source.traceIndex === traceIndex;
      return (
        references.has(artifact.path) ||
        (nodeCounts.get(nodeId) === 1 && artifact.nodeId === nodeId)
      );
    });
    const node = proofNodes.get(nodeId);
    const expectation = node
      ? Object.fromEntries(
          ['assert', 'contains', 'match', 'selector', 'test_id', 'testID', 'text', 'expected']
            .filter((key) => node[key] !== undefined)
            .map((key) => [key, node[key]]),
        )
      : {};
    return [
      {
        traceIndex,
        nodeId: entry.nodeId,
        action: String(entry.action ?? ''),
        intent: typeof entry.intent === 'string' ? entry.intent : entry.nodeId,
        ok: entry.ok === true,
        proves: Array.isArray(entry.proves)
          ? entry.proves.filter((id): id is string => typeof id === 'string')
          : [],
        ...(Object.keys(expectation).length ? { expectation } : {}),
        artifacts: artifacts(
          files.map((artifact) => String(artifact.path)),
          input.artifactPrefix,
        ),
      },
    ];
  });
  const comparison = projectEvidenceComparisons(
    pkg,
    claims,
    input.artifactPrefix ?? '',
    input.artifacts ?? [],
    input.comparisonSnapshot ??
      (input.gateDecision?.payload?.kind === 'ready'
        ? input.gateDecision.payload.prPackage?.reviewSnapshot
        : undefined),
    input.criterionSourceUrl,
    errors.length > 0,
  );
  let comparisonFilter: EvidenceReviewComparisonFilter = 'all';
  let comparisonTransform: EvidenceReviewComparisonTransform = { scale: 1, x: 0.5, y: 0.5 };
  const playbackSources = new Map<
    string,
    {
      segments: readonly RecordingSegmentRef[];
      timelines: ReadonlyMap<string, RecipeRecordingTimelineDocument>;
    }
  >();
  const headTimelines = new Map(timelines);
  for (const timeline of headTimelines.values())
    playbackSources.set(timeline.videoPath, { segments, timelines: headTimelines });
  const addDependencyTimelines = (source: RecordedEvidencePackageInput, prefix: string) => {
    const childTimelines = new Map(
      Object.values(source.timelines).map((timeline) => [
        `${prefix}${timeline.videoPath}`,
        { ...timeline, videoPath: `${prefix}${timeline.videoPath}` },
      ]),
    );
    const childSegments = (source.claims?.recording.segments ?? []).map((segment) => ({
      ...segment,
      videoPath: `${prefix}${segment.videoPath}`,
    }));
    for (const [videoPath, timeline] of childTimelines) {
      timelines.set(videoPath, timeline);
      playbackSources.set(videoPath, { segments: childSegments, timelines: childTimelines });
    }
    for (const child of source.comparisonDependencies ?? [])
      addDependencyTimelines(child.input, `${prefix}${child.artifactRoot}/`);
  };
  for (const child of pkg?.comparisonDependencies ?? [])
    addDependencyTimelines(child.input, `${child.artifactRoot}/`);
  const byClaim = new Map(claims.map((claim) => [claim.id, claim]));
  const byOccurrence = new Map(
    occurrences.map((occurrence) => [occurrence.traceIndex, occurrence]),
  );
  for (const claim of claims) {
    // Retained assertion indices belong to their original trace, never this execution's.
    if (retainedSources.has(claim.id)) continue;
    claim.occurrences = (claim.status?.assertionIndices ?? []).flatMap((index) => {
      const occurrence = byOccurrence.get(index);
      return occurrence ? [occurrence] : [];
    });
  }
  let selection: EvidenceReviewSelection | null = null;
  let clipIndex = 0;
  const effect = (
    seekMs: number | null = null,
    pause = false,
    sourceChanged = false,
  ): EvidenceReviewPlaybackEffect => ({
    clip: selection?.clips[clipIndex] ?? null,
    seekMs,
    pause,
    sourceChanged,
  });

  const advanceClip = (availableEndMs?: number): EvidenceReviewPlaybackEffect => {
    const clip = selection?.clips[clipIndex];
    const next = selection?.clips[clipIndex + 1];
    if (!next) return effect(availableEndMs ?? clip?.endMs ?? null, true);
    clipIndex++;
    return effect(next.startMs, false, true);
  };
  const clipForSpan = (
    timeline: RecipeRecordingTimelineDocument,
    first: RecipeRecordingMarker,
    last: RecipeRecordingMarker,
    caption: string,
    videoDigest = timeline.videoDigest,
  ): EvidenceReviewClip => ({
    videoPath: timeline.videoPath,
    videoDigest,
    traceIndex: first.traceIndex,
    momentMs: (first.startRangeMs[0] + first.startRangeMs[1]) / 2,
    startMs: Math.max(0, first.startRangeMs[0] - EVIDENCE_PADDING_MS),
    endMs: Math.min(timeline.durationMs, last.endRangeMs[1] + EVIDENCE_PADDING_MS),
    caption,
  });
  // One clip derivation for the fresh execution and each retained original.
  const clipsFrom = (
    source: ClipSource,
    traceIndex: number,
    caption: (marker: RecipeRecordingMarker) => string,
  ): EvidenceReviewClip[] => {
    const coverage = occurrenceRecordingCoverage(traceIndex, source.segments, source.timelines);
    if (coverage.timing !== 'measured') return [];
    return coverage.segments.map((segment) => {
      const timeline = source.timelines.get(segment.videoPath)!;
      const marker = timeline.markers.find((entry) => entry.traceIndex === traceIndex)!;
      return {
        ...clipForSpan(timeline, marker, marker, caption(marker), segment.videoDigest),
        ...(source.recipeRunId
          ? {
              moment: {
                recipeRunId: source.recipeRunId,
                videoDigest: segment.videoDigest,
                traceIndex,
              },
            }
          : {}),
      };
    });
  };
  const clipsFor = (traceIndex: number): EvidenceReviewClip[] =>
    errors.length
      ? []
      : clipsFrom(
          { segments, timelines, ...(recipeRunId ? { recipeRunId } : {}) },
          traceIndex,
          (marker) => byOccurrence.get(traceIndex)?.intent ?? marker.nodeId,
        );
  const retainedClipSources = new Map(
    [...retainedSources].map(([claimId, retained]): [string, ClipSource] => [
      claimId,
      {
        timelines: new Map(
          Object.values(retained.input.timelines).map((timeline) => [
            `${retained.prefix}${timeline.videoPath}`,
            { ...timeline, videoPath: `${retained.prefix}${timeline.videoPath}` },
          ]),
        ),
        segments: (retained.input.claims?.recording.segments ?? []).map((segment) => ({
          ...segment,
          videoPath: `${retained.prefix}${segment.videoPath}`,
        })),
        recipeRunId: retained.input.claims!.recipeRunId,
      },
    ]),
  );
  // Long recordings may list every original in the retained ledger. Present
  // only this claim's measured originals; the full file inventory stays browsable.
  for (const claim of claims) {
    const claimClips = (traceIndex: number) =>
      retainedClipSources.has(claim.id)
        ? clipsFrom(retainedClipSources.get(claim.id)!, traceIndex, (marker) => marker.nodeId)
        : clipsFor(traceIndex);
    claim.clips = [...new Set(claim.moments.map((moment) => moment.traceIndex))]
      .flatMap(claimClips)
      .filter((clip) =>
        claim.moments.some(
          (moment) =>
            moment.traceIndex === clip.traceIndex && moment.videoDigest === clip.videoDigest,
        ),
      );
    const measured = new Set(
      claim.moments.flatMap((moment) =>
        claimClips(moment.traceIndex)
          .filter((clip) => clip.videoDigest === moment.videoDigest)
          .map((clip) => clip.videoPath),
      ),
    );
    if (measured.size)
      claim.evidence = artifacts(
        [
          ...claim.evidence
            .filter((file) => file.mediaType !== 'video' || measured.has(file.path))
            .map((file) => file.path),
          ...measured,
        ],
        input.artifactPrefix,
      );
  }
  const select = (
    caption: string,
    files: readonly EvidenceReviewArtifact[],
    clips: EvidenceReviewClip[],
    traceIndex?: number,
    claimId?: string,
    retainedTiming?: EvidenceReviewTiming,
  ): EvidenceReviewSelection => {
    const timing = errors.length
      ? 'untimed'
      : (retainedTiming ??
        (clips.length
          ? 'measured'
          : traceIndex !== undefined
            ? occurrenceRecordingCoverage(traceIndex, segments, timelines).timing
            : 'untimed'));
    const selectedFiles = [
      ...new Map(
        [
          ...files,
          ...artifacts(
            clips.map((clip) => clip.videoPath),
            input.artifactPrefix,
          ),
        ].map((file) => [file.artifactPath, file]),
      ).values(),
    ];
    selection = {
      caption,
      timing,
      clips,
      artifacts: selectedFiles,
      stills: selectedFiles.filter((artifact) => artifact.mediaType === 'image'),
      ...(traceIndex !== undefined ? { traceIndex } : {}),
      ...(claimId ? { claimId } : {}),
      ...(errors.length
        ? { message: errors.join('; ') }
        : !clips.length
          ? {
              message:
                timing === 'outside-recording'
                  ? 'Outside recording.'
                  : 'Untimed evidence; no marker seek.',
            }
          : {}),
    };
    clipIndex = 0;
    return selection;
  };
  const packageStatus = evidenceReviewPackageStatus(
    pkg,
    input.packagePath ?? input.artifactPrefix,
    errors,
    input.contractVersion,
    verdictRecording?.replacedBy,
  );
  const reviewedClaims = claims.filter((claim) => claim.reviewLabels.length);
  const markdownCell = (value: string) =>
    value.replace(/[\r\n]+/gu, ' ').replace(/[\\|`*_[\]<>]/gu, '\\$&');
  const visualReviewMarkdown = reviewedClaims.length
    ? [
        '## Visual judgments',
        '',
        `Execution: ${markdownCell(recipeRunId ?? '')}`,
        '',
        '| Criterion | Verdict | Reviewed by |',
        '| --- | --- | --- |',
        ...reviewedClaims.map(
          (claim) =>
            `| ${markdownCell(`${claim.id}: ${claim.text}`)} | ${markdownCell(claim.status?.verdict ?? 'not assessed')} | ${claim.reviewLabels.map(markdownCell).join('; ')} |`,
        ),
      ].join('\n')
    : '';
  const gatePayload =
    input.gateDecision?.payload?.kind === 'ready' ? input.gateDecision.payload : undefined;
  const nextReason = gatePayload?.gateReadiness?.reasons[0];
  const offeredNext = nextReason?.actionId
    ? input.gateDecision?.actions.find((action) => action.id === nextReason.actionId)
    : undefined;
  const reviewableClaims =
    pkg && !errors.length
      ? deriveReviewedRecipeClaims(pkg).filter(
          (claim) =>
            claim.verdict === 'awaiting-review' &&
            ['visual', 'mixed'].includes(claim.proofMode) &&
            claim.assertionIndices.length,
        )
      : [];
  const pendingVisualClaimIds = claims
    .filter(
      (claim) =>
        claim.status?.verdict === 'awaiting-review' &&
        ['visual', 'mixed'].includes(claim.status?.proofMode ?? ''),
    )
    .map((claim) => claim.id);
  const visualReviewKind = (
    claimId: string,
    principal: SelfPrincipalSummary | null,
  ): NonNullable<RunReviewVisualClaimParams['kind']> | null => {
    const authority = input.visualReviewAuthority;
    if (
      !pkg ||
      !input.visualReviewContext ||
      !authority ||
      authority.historical ||
      input.gateDecision?.resolvedAt ||
      authority.recipeRunId !== packageClaims?.recipeRunId ||
      authority.closureIdentity !== recordedEvidenceClosureIdentity(pkg) ||
      !reviewableClaims.some((claim) => claim.id === claimId)
    )
      return null;
    if (principal?.subjectKind === 'person') return 'person-reviewed';
    return principal?.subjectKind === 'service' &&
      delegatedVisualClaimAllowed(principal.id, authority.projectPolicy)
      ? 'lead-agent-reviewed'
      : null;
  };
  const gateSnapshot: EvidenceReviewGateSnapshot | null = gatePayload
    ? {
        headSha: gatePayload.prPackage?.reviewSnapshot?.headSha ?? gatePayload.headSha,
        reviewRequirement: reviewRequirementDisplay(gatePayload),
        reviews: gatePayload.reviews ?? [],
        ci: gatePayload.prPackage?.deterministicChecks ?? [],
        ciChecks: gatePayload.ciChecks ?? [],
        ownReviewVerdict: gatePayload.reviewVerdict,
        requirements: input.gateDecision
          ? gateDisplayReasons(input.gateDecision)
          : (gatePayload.gateReadiness?.reasons ?? []),
        nextAction: input.gateDecision?.resolvedAt
          ? 'Read retained evidence (read-only)'
          : (offeredNext?.label ??
            (input.gateDecision ? gateWaitReason(input.gateDecision) : undefined) ??
            'Use the current gate action'),
      }
    : null;
  const markerSeekMs: EvidenceReviewModel['markerSeekMs'] = (
    videoPath,
    traceIndex,
    phase,
    mediaDurationMs,
  ) => {
    if (
      errors.length ||
      !playbackSources.has(videoPath) ||
      occurrenceRecordingCoverage(
        traceIndex,
        playbackSources.get(videoPath)!.segments,
        playbackSources.get(videoPath)!.timelines,
      ).timing !== 'measured'
    )
      return null;
    const timeline = timelines.get(videoPath);
    const marker = timeline?.markers.find((marker) => marker.traceIndex === traceIndex);
    if (!timeline || !marker) return null;
    const bounds = phase === 'start' ? marker.startRangeMs : marker.endRangeMs;
    const first = timeline.framesMs[0];
    const last = timeline.framesMs.at(-1);
    const duration = Math.min(timeline.durationMs, mediaDurationMs ?? timeline.durationMs);
    if (
      first === undefined ||
      last === undefined ||
      bounds[1] < first ||
      !Number.isFinite(duration) ||
      bounds[0] >= duration
    )
      return null;
    return clamp((bounds[0] + bounds[1]) / 2, first, Math.min(last, duration));
  };
  const markerBelongsToClaim = (
    videoPath: string,
    marker: RecipeRecordingMarker,
    claimId: string,
  ): boolean =>
    Boolean(marker.proves?.includes(claimId)) ||
    Boolean(
      pkg &&
      packageClaims &&
      !errors.length &&
      headTimelines.has(videoPath) &&
      byClaim
        .get(claimId)
        ?.occurrences.some(
          (occurrence) =>
            occurrence.traceIndex === marker.traceIndex && occurrence.nodeId === marker.nodeId,
        ),
    );
  const timelineGroups: EvidenceReviewModel['timelineGroups'] = (
    videoPath,
    claimId = selection?.claimId,
    mediaDurationMs,
  ) => {
    const timeline = timelines.get(videoPath);
    return timeline
      ? evidenceReviewTimelineGroups(
          timeline.markers,
          (marker, phase) => markerSeekMs(videoPath, marker.traceIndex, phase, mediaDurationMs),
          claimId,
          (marker) => (claimId ? markerBelongsToClaim(videoPath, marker, claimId) : false),
        ).map((group) => ({
          ...group,
          id: `${timeline.videoDigest}:${timeline.traceDigest}:${videoPath}:${group.id}`,
        }))
      : [];
  };
  const claimDisplay = (claimId: string): EvidenceReviewClaimDisplay => {
    const claim = byClaim.get(claimId);
    const row = comparison.rows.find((entry) => entry.claim.id === claimId);
    const captures = [row?.selectedBefore, row?.selectedAfter].filter(
      (media): media is EvidenceReviewComparisonMedia => Boolean(media?.eligible),
    );
    const selectedKeys = gatePayload?.prPackage?.selectedEvidenceKeys;
    const clip = claim?.clips[0] ?? null;
    const selected =
      selectedKeys !== undefined
        ? (claim?.evidence.filter((file) => selectedKeys.includes(file.artifactPath)) ?? [])
        : captures.filter((media) =>
            claim?.evidence.some((file) => file.artifactPath === media.artifactPath),
          );
    const paths = new Set(selected.map((file) => file.artifactPath));
    if (clip) paths.add(`${input.artifactPrefix ?? ''}${clip.videoPath}`);
    return {
      selected,
      raw: claim?.evidence.filter((file) => !paths.has(file.artifactPath)) ?? [],
      clip,
    };
  };
  const claimOverrideCandidate = (id: string) => {
    const claim = packageClaims?.criteria.find(
      (claim) => claim.id === id && claim.kind === 'acceptance',
    );
    return claim && packageClaims && overrideAuthority
      ? { claimId: claim.id, recipeRunId: packageClaims.recipeRunId }
      : null;
  };
  return {
    artifactInventory: input.artifacts ?? [],
    claimDisplay,
    claimHasDetails(id, { playable = false, overridable = false } = {}) {
      const claim = byClaim.get(id);
      const display = claimDisplay(id);
      const status = claim?.status;
      return Boolean(
        (playable && display.clip && !errors.length) ||
        display.selected.length ||
        display.raw.length ||
        status?.recipeNodes.length ||
        claim?.occurrences.length ||
        status?.note ||
        status?.engineVerdict ||
        (claim?.timing && claim.timing !== 'measured') ||
        (overridable && claimOverrideCandidate(id)),
      );
    },
    claimFocusPath(id) {
      if (input.evidencePending) return undefined;
      return (
        claimDisplay(id).selected[0]?.artifactPath ?? byClaim.get(id)?.evidence[0]?.artifactPath
      );
    },
    judgmentRows(principal) {
      return claims.map((claim) => {
        const delegated = judgments
          .filter(
            (judgment) => judgment.claimId === claim.id && judgment.kind !== 'person-reviewed',
          )
          .at(-1);
        return {
          claim,
          pending: pendingVisualClaimIds.includes(claim.id),
          reviewKind: visualReviewKind(claim.id, principal),
          prevalidation: delegated?.reason
            ? {
                verdict: delegated.verdict,
                reason: delegated.reason,
                reviewer: delegated.reviewer.displayName,
                receiptId: delegated.receiptId,
              }
            : null,
          media: claimDisplay(claim.id),
        };
      });
    },
    rawArtifacts(inventory) {
      const paths = new Set([
        ...comparison.rows.flatMap((row) =>
          [row.selectedBefore, row.selectedAfter].flatMap((media) =>
            media?.eligible ? [media.artifactPath] : [],
          ),
        ),
        ...claims.flatMap((claim) => {
          const display = claimDisplay(claim.id);
          return [
            ...display.selected.map((file) => file.artifactPath),
            ...(display.clip ? [`${input.artifactPrefix ?? ''}${display.clip.videoPath}`] : []),
          ];
        }),
      ]);
      return inventory.filter((file) => !paths.has(file.path));
    },
    artifactRole(path) {
      const media = comparison.media.find((entry) => entry.artifactPath === path && entry.eligible);
      return media?.capture?.role ?? null;
    },
    pairedArtifacts(artifacts) {
      return comparison.rows.flatMap((row) => {
        const before = row.selectedBefore?.eligible
          ? artifacts.find((artifact) => artifact.path === row.selectedBefore?.artifactPath)
          : undefined;
        const after = row.selectedAfter?.eligible
          ? artifacts.find((artifact) => artifact.path === row.selectedAfter?.artifactPath)
          : undefined;
        return before && after ? [{ before, after, claimId: row.claim.id }] : [];
      });
    },
    pendingVisualClaimIds,
    visualReviewKind,
    visualReviewRequest(claimId, principal, verdict, reason) {
      const kind = visualReviewKind(claimId, principal);
      if (!kind || !input.visualReviewContext || !input.visualReviewAuthority || !packageClaims)
        throw new Error(
          'This claim requires an authorized reviewer and a captured evidence selection.',
        );
      if (!validVisualJudgmentReason(kind, verdict, reason))
        throw new Error('An issue or delegated review needs a reason.');
      return {
        runId: input.visualReviewAuthority.runId,
        decisionId: input.visualReviewContext.decisionId,
        snapshotIdentity: input.visualReviewContext.snapshotIdentity,
        // A retained claim is judged against its original execution.
        recipeRunId:
          retainedSources.get(claimId)?.input.claims!.recipeRunId ?? packageClaims.recipeRunId,
        claimId,
        kind,
        verdict,
        ...(reason?.trim() ? { reason: reason.trim() } : {}),
      };
    },
    gateSnapshot,
    comparisonErrors: comparison.media
      .filter((media) => media.limitationCode === 'comparison-source-mismatch')
      .map((media) => ({
        code: 'comparison-source-mismatch' as const,
        artifactPath: media.artifactPath,
        message: media.limitation!,
      })),
    comparisons: comparison.rows,
    unassigned: comparison.unassigned,
    get comparisonFilter() {
      return comparisonFilter;
    },
    get comparisonTransform() {
      return comparisonTransform;
    },
    get comparisonView() {
      const filtered = (media: readonly EvidenceReviewComparisonMedia[]) =>
        media.filter((entry) => matchesComparisonFilter(entry, comparisonFilter));
      return {
        rows:
          comparisonFilter === 'unassigned'
            ? []
            : comparison.rows.map((row) => {
                const display = claimDisplay(row.claim.id);
                const primaryClip =
                  comparisonFilter === 'all' || comparisonFilter === 'moments'
                    ? display.clip
                    : null;
                const shownPaths = new Set([
                  row.selectedBefore?.artifactPath,
                  row.selectedAfter?.artifactPath,
                ]);
                if (primaryClip)
                  shownPaths.add(`${input.artifactPrefix ?? ''}${primaryClip.videoPath}`);
                return {
                  ...row,
                  primaryClip,
                  primaryFiles: display.selected.filter(
                    (file) =>
                      !shownPaths.has(file.artifactPath) &&
                      (comparisonFilter === 'all' ||
                        (comparisonFilter === 'screenshots' && file.mediaType === 'image')),
                  ),
                  claim: {
                    ...row.claim,
                    clips:
                      comparisonFilter === 'all' || comparisonFilter === 'moments'
                        ? row.claim.clips
                        : [],
                  },
                  before: filtered(row.before),
                  after: filtered(row.after),
                  review: filtered(row.review),
                  selectedBefore: filtered(row.before).find(
                    (media) => media.identity === row.selectedBefore?.identity,
                  ),
                  selectedAfter: filtered(row.after).find(
                    (media) => media.identity === row.selectedAfter?.identity,
                  ),
                };
              }),
        unassigned: ['all', 'unassigned', 'screenshots', 'moments'].includes(comparisonFilter)
          ? filtered(comparison.unassigned)
          : [],
      };
    },
    setComparisonFilter(filter) {
      comparisonFilter = filter;
    },
    chooseComparisonMedia(claimId, role, identity) {
      const row = comparison.rows.find((entry) => entry.claim.id === claimId);
      const media = row?.[role].find((entry) => entry.identity === identity);
      if (!row || !media?.eligible) return false;
      if (role === 'before') row.selectedBefore = media;
      else row.selectedAfter = media;
      comparisonTransform = { scale: 1, x: 0.5, y: 0.5 };
      return true;
    },
    setComparisonTransform(transform) {
      comparisonTransform = normalizedComparisonTransform(transform);
    },
    resetComparisonTransform() {
      comparisonTransform = { scale: 1, x: 0.5, y: 0.5 };
    },
    selectComparisonMedia(identity) {
      const media = comparison.media.find((entry) => entry.identity === identity);
      return media
        ? select(
            media.name,
            [media],
            [...media.clips],
            media.capture?.traceIndex,
            media.capture?.ac,
            media.timing,
          )
        : null;
    },
    context: input.context ?? 'artifact',
    claimOverrideCandidate,
    summary: summarizeAcceptanceStatus(
      {
        schemaVersion: 1,
        criteria: claims.flatMap((claim) => (claim.status ? [claim.status] : [])),
      },
      claims,
    ),
    claims,
    visualReviewMarkdown,
    occurrences,
    // Panel-level evidence details describe the current recording only, never a replaced one.
    currentOccurrences: replaced ? [] : occurrences,
    recordings: [...timelines.values()],
    errors,
    warnings,
    displayWarnings: replaced
      ? []
      : [...new Set(warnings)].filter(
          (warning) => packageStatus?.status !== 'Legacy' || !warning.startsWith('Legacy package'),
        ),
    report: input.report,
    packageStatus,
    recording: verdictRecording,
    get selection() {
      return selection;
    },
    get playback() {
      return effect();
    },
    artifactPath(path) {
      return `${input.artifactPrefix ?? ''}${path}`;
    },
    selectClaim(id, artifactPath) {
      const claim = byClaim.get(id);
      if (
        !claim ||
        (artifactPath &&
          !claim.evidence.some(
            (file) => file.path === artifactPath || file.artifactPath === artifactPath,
          ))
      )
        return null;
      const indices = [
        ...new Set(
          claim.moments.length
            ? claim.moments.map((moment) => moment.traceIndex)
            : (claim.status?.assertionIndices ?? []),
        ),
      ];
      const clips = indices
        .flatMap(clipsFor)
        .filter((clip) =>
          claim.moments.some(
            (moment) =>
              moment.traceIndex === clip.traceIndex && moment.videoDigest === clip.videoDigest,
          ),
        );
      const selected = select(claim.caption, claim.evidence, clips, indices[0], id, claim.timing);
      if (artifactPath) {
        const file = claim.evidence.find(
          (file) => file.path === artifactPath || file.artifactPath === artifactPath,
        );
        if (file?.mediaType === 'video') {
          const index = selected.clips.findIndex((clip) => clip.videoPath === file.path);
          if (index >= 0) clipIndex = index;
          else {
            selected.clips = [];
            selected.timing = 'untimed';
            selected.message = 'This original has no measured clip for the selected claim.';
          }
        }
      }
      return selected;
    },
    selectOccurrence(traceIndex, recording) {
      if (recording) {
        const timeline = timelines.get(recording.videoPath);
        const marker = timeline?.markers.find((entry) => entry.traceIndex === traceIndex);
        if (
          !timeline ||
          !marker ||
          markerSeekMs(
            recording.videoPath,
            traceIndex,
            recording.phase ?? 'start',
            recording.mediaDurationMs,
          ) === null
        )
          return null;
        const claimId = selection?.claimId;
        if (claimId && !markerBelongsToClaim(recording.videoPath, marker, claimId)) return null;
        const occurrence = headTimelines.has(recording.videoPath)
          ? byOccurrence.get(traceIndex)
          : undefined;
        const clips = headTimelines.has(recording.videoPath)
          ? clipsFor(traceIndex).filter((clip) => clip.videoPath === recording.videoPath)
          : [];
        return select(
          marker.intent ?? marker.nodeId,
          occurrence?.artifacts ?? [],
          clips.length
            ? clips
            : [clipForSpan(timeline, marker, marker, marker.intent ?? marker.nodeId)],
          traceIndex,
          claimId,
        );
      }
      const occurrence = byOccurrence.get(traceIndex);
      return occurrence
        ? select(occurrence.intent, occurrence.artifacts, clipsFor(traceIndex), traceIndex)
        : null;
    },
    timelineGroups,
    selectTimelineGroup(videoPath, groupId, mediaDurationMs) {
      const group = timelineGroups(videoPath, selection?.claimId, mediaDurationMs).find(
        (entry) => entry.id === groupId,
      );
      const timeline = timelines.get(videoPath);
      if (!timeline || !group?.startMarker || !group.endMarker || group.startMs === null)
        return effect(null, true);
      select(
        group.summary,
        [],
        [clipForSpan(timeline, group.startMarker, group.endMarker, group.summary)],
        group.startMarker.traceIndex,
        selection?.claimId,
        group.unrecorded ? 'outside-recording' : 'measured',
      );
      return effect(group.startMs, false, true);
    },
    clearSelection() {
      selection = null;
      clipIndex = 0;
    },
    selectReport() {
      const path = input.report?.reportPath;
      if (!path || !input.report?.artifactManifest.some((artifact) => artifact.path === path))
        return null;
      const selected = select(
        `Report snapshot ${input.report.artifactBundle?.bundleDigest ?? input.report.manifestDigest}`,
        artifacts([path]),
        [],
      );
      if (reportWarning)
        selected.caption += ` ${reportWarning} Retained snapshot ${input.report.artifactBundle?.bundleDigest ?? input.report.manifestDigest}${input.reportSnapshot ? `; expected ${input.reportSnapshot.manifestDigest}` : ''}. Read-only access does not approve it.`;
      return selected;
    },
    cueClip(index) {
      if (!selection?.clips[index]) return effect(null, true);
      clipIndex = index;
      return effect(selection.clips[index]!.startMs, false, true);
    },
    seekClip(timeMs) {
      const clip = selection?.clips[clipIndex];
      return clip && Number.isFinite(timeMs)
        ? effect(clamp(timeMs, clip.startMs, clip.endMs))
        : effect(null, true);
    },
    playbackAt(videoPath, timeMs, mediaDurationMs) {
      const clip = selection?.clips[clipIndex];
      if (!clip || clip.videoPath !== videoPath || !Number.isFinite(timeMs)) return effect();
      if (timeMs < clip.startMs) return effect(clip.startMs);
      const availableEnd = Number.isFinite(mediaDurationMs)
        ? Math.min(clip.endMs, mediaDurationMs!)
        : clip.endMs;
      if (timeMs < availableEnd) return effect();
      return advanceClip(availableEnd);
    },
    markerSeekMs,
    adjacentFrameMs(videoPath, timeMs, direction) {
      const timeline = errors.length ? undefined : timelines.get(videoPath);
      if (!timeline?.framesMs.length || !Number.isFinite(timeMs)) return null;
      const current = Math.max(0, upperFrame(timeline.framesMs, timeMs + 0.001) - 1);
      return timeline.framesMs[clamp(current + direction, 0, timeline.framesMs.length - 1)]!;
    },
    displayedFrameRangeMs(videoPath, timeMs, mediaDurationMs) {
      const timeline = errors.length ? undefined : timelines.get(videoPath);
      const duration = Math.min(
        timeline?.durationMs ?? 0,
        mediaDurationMs ?? timeline?.durationMs ?? 0,
      );
      if (
        !timeline?.framesMs.length ||
        timeMs < timeline.framesMs[0]! ||
        !Number.isFinite(timeMs) ||
        timeMs >= duration
      )
        return null;
      const next = upperFrame(timeline.framesMs, timeMs);
      return [
        timeline.framesMs[next - 1]!,
        Math.min(timeline.framesMs[next] ?? duration, duration),
      ];
    },
  };
}

function upperFrame(frames: readonly number[], timeMs: number): number {
  let low = 0;
  let high = frames.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (frames[middle]! <= timeMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function artifacts(paths: readonly string[], prefix = ''): EvidenceReviewArtifact[] {
  return [...new Set(paths)].map((path) => ({
    path,
    artifactPath: `${prefix}${path}`,
    name: path.split('/').at(-1) || path,
    mediaType: /\.(?:png|jpe?g|webp|gif|svg)$/iu.test(path)
      ? 'image'
      : /\.(?:mp4|mov|webm|m4v)$/iu.test(path)
        ? 'video'
        : 'document',
  }));
}

function claimCaption(claim: AcceptanceCriterionView): string {
  const status = claim.status;
  return status
    ? [
        claim.id,
        status.verdict,
        ...(status.engineVerdict ? [`engine: ${status.engineVerdict}`, status.note ?? ''] : []),
        status.proofMode ?? 'no proof mode',
        status.recipeNodes.length ? `node ${status.recipeNodes.join(', ')}` : 'no recipe node',
      ].join(' · ')
    : `${claim.id} · not assessed`;
}
