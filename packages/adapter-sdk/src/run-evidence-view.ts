import {
  type AcceptanceStatusSummary,
  acceptanceVerdictLabel,
  type RecipeClaimKind,
} from '@farmslot/protocol';

import type {
  EvidenceReviewArtifact,
  EvidenceReviewMediaType,
  EvidenceReviewModel,
  EvidenceReviewOccurrence,
  EvidenceReviewTiming,
} from './evidence-review-model.js';
import { proofStepGroups } from './evidence-review-toc.js';

/** Bumped only for a breaking change to the shape templates read. */
export const RUN_EVIDENCE_VIEW_VERSION = 1;

/** What the page knows about the run beyond its evidence. */
export interface RunEvidenceViewRun {
  /** The run folder name, or the gateway run id. */
  id: string;
  title?: string;
  /** `running` until the run writes its summary. */
  status: 'pass' | 'fail' | 'running' | 'unknown';
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
}

export interface RunEvidenceFile {
  /** Transport path, the model's `artifactPath`. */
  path: string;
  name: string;
  mediaType: EvidenceReviewMediaType;
}

/** Where a claim or a step plays in one recording, in media milliseconds. */
export interface RunEvidenceCue {
  videoPath: string;
  startMs: number;
  endMs: number;
}

export interface RunEvidenceCriterion {
  id: string;
  text: string;
  kind: RecipeClaimKind;
  parentId?: string;
  /** The recorded verdict, or null when none is recorded yet. */
  verdict: string | null;
  verdictLabel: string;
  timing?: EvidenceReviewTiming;
  /** The claim's first padded measured clip; null when nothing seekable proves it. */
  cue: RunEvidenceCue | null;
  /** Evidence files other than the recording. */
  files: RunEvidenceFile[];
  /** The selected before and after captures, only when both exist. */
  pair: { before: RunEvidenceFile; after: RunEvidenceFile } | null;
  /** The trace steps that prove it. */
  traceIndexes: number[];
  note?: string;
}

export interface RunEvidenceStep {
  traceIndex: number;
  nodeId: string;
  action: string;
  intent: string;
  ok: boolean;
  proves: string[];
  files: RunEvidenceFile[];
  /** Where this execution's own recording shows the step; null when none measured it. */
  cue: RunEvidenceCue | null;
  /** Milliseconds from the run's start to the step's; null when the trace has no time. */
  atMs: number | null;
}

/** A recording the page can play. Only a measured one has cues; an untimed one plays by hand. */
export interface RunEvidenceVideo {
  path: string;
  measured: boolean;
  durationMs?: number;
}

export interface RunEvidenceStepGroup {
  label: string;
  steps: RunEvidenceStep[];
  failed: number;
}

/**
 * The run evidence page's view-model: plain JSON projected from the shared review model, so
 * the local viewer, its project templates and Command Center read the same facts.
 */
export interface RunEvidenceView {
  version: typeof RUN_EVIDENCE_VIEW_VERSION;
  run: RunEvidenceViewRun | null;
  summary: AcceptanceStatusSummary;
  /** Every criterion in the run's own order. */
  criteria: RunEvidenceCriterion[];
  /** Every step the current execution ran, in trace order, repeats included. */
  steps: RunEvidenceStep[];
  /** The same steps grouped by the criterion they prove, then the rest. */
  stepGroups: RunEvidenceStepGroup[];
  videos: RunEvidenceVideo[];
  errors: string[];
  warnings: string[];
}

function file(artifact: Pick<EvidenceReviewArtifact, 'artifactPath' | 'name' | 'mediaType'>) {
  return { path: artifact.artifactPath, name: artifact.name, mediaType: artifact.mediaType };
}

/** Measured recordings, then retained originals without a timeline: those still play. */
function videos(model: EvidenceReviewModel): RunEvidenceVideo[] {
  const measured: RunEvidenceVideo[] = model.recordings.map((timeline) => ({
    path: model.artifactPath(timeline.videoPath),
    measured: true,
    durationMs: timeline.durationMs,
  }));
  const seen = new Set(measured.map((video) => video.path));
  const untimed = model.claims
    .flatMap((claim) => claim.evidence)
    .filter((entry) => entry.mediaType === 'video' && !seen.has(entry.artifactPath))
    .map((entry) => entry.artifactPath);
  return [...measured, ...[...new Set(untimed)].map((path) => ({ path, measured: false }))];
}

/** Project the shared review model; reads only, never moves the model's selection. */
export function runEvidenceView(
  model: EvidenceReviewModel,
  run: RunEvidenceViewRun | null = null,
): RunEvidenceView {
  // A step seeks only its own execution's recording: a baseline's index is another trace's.
  const stepCue = (traceIndex: number): RunEvidenceCue | null => {
    for (const { videoPath } of model.currentRecordings) {
      const startMs = model.markerSeekMs(videoPath, traceIndex, 'start');
      const endMs = model.markerSeekMs(videoPath, traceIndex, 'end');
      if (startMs !== null && endMs !== null)
        return { videoPath: model.artifactPath(videoPath), startMs, endMs };
    }
    return null;
  };
  const runStart = Date.parse(run?.startedAt ?? model.currentOccurrences[0]?.startedAt ?? '');
  const step = (occurrence: EvidenceReviewOccurrence): RunEvidenceStep => {
    const atMs = Date.parse(occurrence.startedAt ?? '') - runStart;
    return {
      traceIndex: occurrence.traceIndex,
      nodeId: occurrence.nodeId,
      action: occurrence.action,
      intent: occurrence.intent,
      ok: occurrence.ok,
      proves: [...occurrence.proves],
      files: occurrence.artifacts.map(file),
      cue: stepCue(occurrence.traceIndex),
      atMs: Number.isFinite(atMs) ? Math.max(0, atMs) : null,
    };
  };
  const steps = model.currentOccurrences.map(step);
  const byIndex = new Map(steps.map((entry) => [entry.traceIndex, entry]));
  return {
    version: RUN_EVIDENCE_VIEW_VERSION,
    run,
    summary: { ...model.summary },
    criteria: model.claims.map((claim) => {
      const clip = claim.clips[0];
      const row = model.comparisons.find((entry) => entry.claim.id === claim.id);
      return {
        id: claim.id,
        text: claim.text,
        kind: claim.kind,
        ...(claim.parentId ? { parentId: claim.parentId } : {}),
        verdict: claim.status?.verdict ?? null,
        verdictLabel: claim.status ? acceptanceVerdictLabel(claim.status) : 'no verdict',
        ...(claim.timing ? { timing: claim.timing } : {}),
        cue: clip
          ? {
              videoPath: model.artifactPath(clip.videoPath),
              startMs: clip.startMs,
              endMs: clip.endMs,
            }
          : null,
        files: claim.evidence.filter((entry) => entry.mediaType !== 'video').map(file),
        pair:
          row?.selectedBefore && row.selectedAfter
            ? { before: file(row.selectedBefore), after: file(row.selectedAfter) }
            : null,
        traceIndexes: [...new Set(claim.occurrences.map((entry) => entry.traceIndex))],
        ...(claim.status?.note ? { note: claim.status.note } : {}),
      };
    }),
    steps,
    stepGroups: proofStepGroups(model.currentOccurrences).map((group) => ({
      label: group.label,
      steps: group.steps.map((entry) => byIndex.get(entry.traceIndex)!),
      failed: group.failed,
    })),
    videos: videos(model),
    errors: [...model.errors],
    warnings: [...model.displayWarnings],
  };
}
