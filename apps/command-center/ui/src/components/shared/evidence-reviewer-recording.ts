import {
  evidenceRecordingRevision,
  type EvidenceReviewModel,
} from '@farmslot/adapter-sdk/evidence';
import type { RunRecipeRunsForRunResult } from '@farmslot/protocol';

import type { EvidenceReviewerSelection } from './evidence-reviewer.js';
import { isVideoLightboxItem } from './media-lightbox-model.js';
import type { LightboxItem } from './media-lightbox-types.js';

export const INSPECTION_CONTEXT_CAPTION = 'Same-attempt inspection context · not AC-bound';

/**
 * The review for one criterion of a run: its recording (the opened one, else the
 * run's first) and the file the user chose. Every host opens the review through this.
 */
export function evidenceReviewerSelection(input: {
  model: EvidenceReviewModel;
  claimId: string;
  resolveUrl: (path: string) => string;
  opened?: LightboxItem;
  recordingPath?: string;
  recordingRevision?: string;
}): EvidenceReviewerSelection {
  const { model, resolveUrl } = input;
  const media = model.claimMedia(input.claimId);
  const original = media.recording;
  // A video from another recipe run would carry that run's trace markers: open the
  // model's own recording. Hosts rebuild the selection as the model loads.
  const accepted =
    input.opened &&
    isVideoLightboxItem(input.opened) &&
    (original || model.recordings.length > 0) &&
    !model.recordingForPath(input.opened.path)
      ? undefined
      : input.opened;
  const opened =
    accepted &&
    media.screenshots.some(
      ({ artifact, inspection }) => inspection && artifact.artifactPath === accepted.path,
    )
      ? { ...accepted, caption: INSPECTION_CONTEXT_CAPTION, evidenceModel: undefined }
      : accepted;
  const requestedRecording = input.recordingPath;
  const revisionMismatch =
    Boolean(input.recordingRevision) &&
    evidenceRecordingRevision(model, requestedRecording) !== input.recordingRevision;
  const selectedRecording =
    !revisionMismatch && requestedRecording && model.recordingForPath(requestedRecording);
  const path = selectedRecording ? requestedRecording : original?.artifactPath;
  const linkUnavailable =
    revisionMismatch || (input.opened && !accepted) || (requestedRecording && !selectedRecording);
  const recording =
    revisionMismatch || (requestedRecording && !selectedRecording)
      ? null
      : opened &&
          isVideoLightboxItem(opened) &&
          (!requestedRecording || opened.path === requestedRecording)
        ? opened
        : path
          ? {
              url: resolveUrl(path),
              path,
              purpose: 'recording',
              evidenceModel: model,
              resolveArtifactUrl: resolveUrl,
            }
          : null;
  return {
    claimId: input.claimId,
    model,
    recording: pinRecordingUrl(recording, model),
    resolveUrl,
    opened: revisionMismatch ? undefined : opened,
    recordingPath: requestedRecording,
    recordingRevision: input.recordingRevision,
    ...(linkUnavailable ? { linkedRecordingUnavailable: true } : {}),
  };
}

/** The artifact route rejects paths whose retained entry has a different digest. */
function pinRecordingUrl(
  item: LightboxItem | null,
  model: EvidenceReviewModel,
): LightboxItem | null {
  if (!item) return null;
  const digest = model.recordingForPath(item.path)?.videoDigest?.replace(/^sha256:/u, '');
  if (!digest) return item;
  const relative = item.url.startsWith('/') && !item.url.startsWith('//');
  const base = relative ? 'http://localhost' : undefined;
  if (!URL.canParse(item.url, base)) return item;
  const url = new URL(item.url, base);
  if (url.pathname !== '/api/run-artifact') return item;
  url.searchParams.set('v', digest);
  return {
    ...item,
    url: relative ? url.pathname + url.search + url.hash : url.toString(),
  };
}

const recipeIdsByGroup = new WeakMap<
  RunRecipeRunsForRunResult['recipeRuns'],
  ReadonlyMap<string, string | null>
>();

/** Read the group inventory only when a link actually names a group alias. */
export function gateReviewAttemptMatches(
  source: RunRecipeRunsForRunResult | undefined,
  groupId?: string,
  revision?: string,
): boolean {
  if (!groupId || (groupId === 'current-artifacts' && revision)) return true;
  const attempt =
    source?.selectedRecipeRunId ?? source?.recordedEvidence?.input?.claims?.recipeRunId;
  if (!attempt || !source) return false;
  if (groupId === attempt) return true;
  let recipeIds = recipeIdsByGroup.get(source.recipeRuns);
  if (!recipeIds) {
    recipeIds = new Map(source.recipeRuns.map(({ id, recipeRunId }) => [id, recipeRunId]));
    recipeIdsByGroup.set(source.recipeRuns, recipeIds);
  }
  return recipeIds.get(groupId) === attempt;
}

/** Run Detail group paths are relative to the package root inside a frozen gate. */
export function gateReviewArtifactPath(
  model: Pick<EvidenceReviewModel, 'artifactPath'>,
  path: string,
): string {
  const prefix = model.artifactPath('');
  return prefix && path.startsWith('artifacts/') && !path.startsWith(prefix)
    ? model.artifactPath(path.slice('artifacts/'.length))
    : path;
}

/** A fallback file remains playable while its recording metadata is being read. */
export function evidenceRecordingPin(
  model: EvidenceReviewModel,
  path?: string,
): Pick<EvidenceReviewerSelection, 'recordingPath' | 'recordingRevision'> {
  if (!path || !model.recordingForPath(path)) return {};
  const revision = evidenceRecordingRevision(model, path);
  return { recordingPath: path, ...(revision ? { recordingRevision: revision } : {}) };
}

export {
  evidenceRecordingRevision,
  evidenceReviewerTimeline,
  type EvidenceReviewerTimelineRow,
} from '@farmslot/adapter-sdk/evidence';
