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
  isRecord,
  type OutputReviewPayload,
  projectClaimUntestableOverride,
  type RecipeClaimDeclaration,
  type RecipeClaimKind,
  type RecipeRecordingTimelineBinding,
  type RecipeRecordingTimelineDocument,
  recipeTraceEntries,
  type RecipeVisualJudgmentKind,
  type RecipeVisualReviewAuthority,
  recordedEvidenceClosureIdentity,
  type RecordedEvidencePackageInput,
  recordedVisualJudgments,
  type RecordingSegmentRef,
  type ReviewDiffSnapshot,
  type ReviewRequirementDisplay,
  reviewRequirementDisplay,
  type ReviewStatus,
  type RunDecision,
  type RunGatePrerequisiteReason,
  type RunOutput,
  type RunReviewVisualClaimParams,
  type SelfPrincipalSummary,
  summarizeAcceptanceStatus,
  validateRecipeRecordingTimelineBinding,
} from '@farmslot/protocol';
import {
  deriveReviewedRecipeClaims,
  indexRecordingTimelines,
  occurrenceRecordingCoverage,
  planRecipeEvidence,
  proofDocument,
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
} from './evidence-review-status.js';

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
  /** Transport namespace; contract references stay relative to their recipe package. */
  artifactPrefix?: string;
  /** Display path relative to the run's artifacts; never used to resolve media. */
  packagePath?: string;
  package?: RecordedEvidencePackageInput;
  criteria?: readonly AcceptanceCriterionRef[];
  ledger?: AcceptanceStatusLedger | null;
  evidenceLinks?: readonly AcceptanceEvidenceLink[];
  recordings?: readonly EvidenceReviewRecordingInput[];
  report?: Pick<RunOutput, 'reportPath' | 'manifestDigest' | 'artifactManifest'>;
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

export interface EvidenceReviewModel {
  artifactRole(path: string): 'before' | 'after' | 'review' | null;
  pairedArtifacts<T extends { path: string }>(
    artifacts: readonly T[],
  ): EvidenceReviewArtifactPair<T>[];
  readonly pendingVisualClaimIds: readonly string[];
  visualReviewKind(
    claimId: string,
    principal: SelfPrincipalSummary | null,
  ): RecipeVisualJudgmentKind | null;
  visualReviewRequest(
    claimId: string,
    principal: SelfPrincipalSummary | null,
    verdict: 'confirmed' | 'rejected',
    reason: string,
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
    rows: readonly EvidenceReviewComparisonRow[];
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
  readonly context: EvidenceReviewContext;
  readonly summary: AcceptanceStatusSummary;
  readonly claims: readonly EvidenceReviewClaim[];
  readonly visualReviewMarkdown: string;
  readonly occurrences: readonly EvidenceReviewOccurrence[];
  readonly recordings: readonly RecipeRecordingTimelineDocument[];
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly displayWarnings: readonly string[];
  readonly selection: EvidenceReviewSelection | null;
  readonly playback: EvidenceReviewPlaybackEffect;
  readonly report: EvidenceReviewInput['report'];
  readonly reportError?: string;
  readonly packageStatus: EvidenceReviewPackageStatus | null;
  selectClaim(id: string, artifactPath?: string): EvidenceReviewSelection | null;
  selectOccurrence(traceIndex: number): EvidenceReviewSelection | null;
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
  const reportError =
    input.reportSnapshot &&
    (input.report?.manifestDigest !== input.reportSnapshot.manifestDigest ||
      input.report?.reportPath !== input.reportSnapshot.reportPath)
      ? 'The output report no longer matches the reviewed snapshot.'
      : undefined;
  if (reportError) errors.push(reportError);
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
  const ledger = packageClaims
    ? {
        ...packageClaims,
        criteria: (reviewed ?? []).map((claim) => {
          const original = packageClaims.criteria.find(({ id }) => id === claim.id)!;
          const override = overrideAuthority
            ? projectClaimUntestableOverride(original, overrideAuthority)
            : original;
          return override !== original ? override : claim;
        }),
      }
    : (input.ledger ?? null);
  if (input.ledger?.schemaVersion === 1 && !packageClaims) {
    warnings.push(
      'Legacy schema-1 task verdicts are retained display only; they establish no recorded recipe proof.',
    );
    if (input.contractVersion === 1)
      errors.push(
        'Current run evidence requires schema-2 engine claims and their selected execution package.',
      );
  }
  if (input.ledger?.schemaVersion === 2 && !pkg)
    errors.push('Recorded claim evidence requires its retained execution package.');
  if (
    packageClaims &&
    input.ledger?.schemaVersion === 2 &&
    packageClaims.recipeRunId !== input.ledger.recipeRunId
  )
    errors.push('The task ledger belongs to another recipe execution.');
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
      ? recordedVisualJudgments(pkg, input.visualReviewAuthority)
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
      const claim = packageClaims?.criteria.find(({ id }) => id === claimId);
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
          judgment.kind === 'lead-agent-reviewed'
            ? ('agent-reviewed' as const)
            : ('person-reviewed' as const),
        ),
      ]),
    ],
    reviewLabels: reviewContributions(claim.id).map(
      (judgment) =>
        `${judgment.kind === 'lead-agent-reviewed' ? `agent-reviewed (delegated by ${judgment.delegation!.displayName})` : 'person-reviewed'} · ${judgment.reviewer.displayName}`,
    ),
    kind: claim.status?.kind ?? 'acceptance',
    ...(claim.status?.parentId ? { parentId: claim.status.parentId } : {}),
    caption: claimCaption(claim),
    timing: packageClaims?.criteria.find((status) => status.id === claim.id)?.timing,
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
  const clipsFor = (traceIndex: number): EvidenceReviewClip[] => {
    if (errors.length) return [];
    const coverage = occurrenceRecordingCoverage(traceIndex, segments, timelines);
    if (coverage.timing !== 'measured') return [];
    return coverage.segments.map((segment) => {
      const timeline = timelines.get(segment.videoPath)!;
      const marker = timeline.markers.find((marker) => marker.traceIndex === traceIndex)!;
      return {
        videoPath: segment.videoPath,
        videoDigest: segment.videoDigest,
        traceIndex,
        momentMs: (marker.startRangeMs[0] + marker.startRangeMs[1]) / 2,
        startMs: Math.max(0, marker.startRangeMs[0] - EVIDENCE_PADDING_MS),
        endMs: Math.min(timeline.durationMs, marker.endRangeMs[1] + EVIDENCE_PADDING_MS),
        caption: byOccurrence.get(traceIndex)?.intent ?? marker.nodeId,
        ...(recipeRunId
          ? { moment: { recipeRunId, videoDigest: segment.videoDigest, traceIndex } }
          : {}),
      };
    });
  };
  // Long recordings may list every original in the retained ledger. Present
  // only this claim's measured originals; the full file inventory stays browsable.
  for (const claim of claims) {
    claim.clips = [...new Set(claim.moments.map((moment) => moment.traceIndex))]
      .flatMap(clipsFor)
      .filter((clip) =>
        claim.moments.some(
          (moment) =>
            moment.traceIndex === clip.traceIndex && moment.videoDigest === clip.videoDigest,
        ),
      );
    const measured = new Set(
      claim.moments.flatMap((moment) =>
        clipsFor(moment.traceIndex)
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
        reviewableClaims.some((raw) => raw.id === claim.id),
    )
    .map((claim) => claim.id);
  const visualReviewKind = (
    claimId: string,
    principal: SelfPrincipalSummary | null,
  ): RecipeVisualJudgmentKind | null => {
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
      delegatedVisualClaimAllowed(pkg, claimId, principal.id, authority.projectPolicy)
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
        requirements: gatePayload.gateReadiness?.reasons ?? [],
        nextAction: input.gateDecision?.resolvedAt
          ? 'Read retained evidence (read-only)'
          : (offeredNext?.label ?? nextReason?.message ?? 'Use the current gate action'),
      }
    : null;
  return {
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
      if (!reason.trim()) throw new Error('Describe the visual proof you inspected.');
      return {
        runId: input.visualReviewAuthority.runId,
        decisionId: input.visualReviewContext.decisionId,
        snapshotIdentity: input.visualReviewContext.snapshotIdentity,
        recipeRunId: packageClaims.recipeRunId,
        claimId,
        kind,
        verdict,
        reason: reason.trim(),
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
            : comparison.rows.map((row) => ({
                ...row,
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
              })),
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
    claimOverrideCandidate(id) {
      const claim = packageClaims?.criteria.find(
        (claim) => claim.id === id && claim.kind === 'acceptance',
      );
      return claim && packageClaims && overrideAuthority
        ? { claimId: claim.id, recipeRunId: packageClaims.recipeRunId }
        : null;
    },
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
    recordings: [...timelines.values()],
    errors,
    warnings,
    displayWarnings: [...new Set(warnings)].filter(
      (warning) => packageStatus?.status !== 'Legacy' || !warning.startsWith('Legacy package'),
    ),
    report: input.report,
    reportError,
    packageStatus,
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
    selectOccurrence(traceIndex) {
      const occurrence = byOccurrence.get(traceIndex);
      return occurrence
        ? select(occurrence.intent, occurrence.artifacts, clipsFor(traceIndex), traceIndex)
        : null;
    },
    clearSelection() {
      selection = null;
      clipIndex = 0;
    },
    selectReport() {
      const path = input.report?.reportPath;
      if (
        reportError ||
        !path ||
        !input.report?.artifactManifest.some((artifact) => artifact.path === path)
      )
        return null;
      return select(`Report snapshot ${input.report.manifestDigest}`, artifacts([path]), []);
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
    markerSeekMs(videoPath, traceIndex, phase, mediaDurationMs) {
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
    },
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
