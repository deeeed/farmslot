import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

import {
  type RecipeRecordingTimelineBinding,
  type RecipeRecordingTimelineDocument,
  validateRecipeRecordingTimelineDocument,
} from '@farmslot/protocol';

import {
  createEvidenceReviewModel,
  type EvidenceReviewContext,
  type EvidenceReviewModel,
} from './evidence-review-model.js';

export interface RecordingEvidenceReadRequest extends Omit<
  RecipeRecordingTimelineBinding,
  'trace'
> {
  context?: EvidenceReviewContext;
  timelinePath: string;
  readJson(path: string): Promise<unknown>;
}

/** Shared metadata loading for existing standalone video players; no media is downloaded. */
export async function loadRecordingEvidenceReview(
  input: RecordingEvidenceReadRequest,
): Promise<EvidenceReviewModel> {
  const value = await input.readJson(input.timelinePath);
  const validation = validateRecipeRecordingTimelineDocument(value);
  if (validation.status !== 'valid') throw new Error('Recording timeline is invalid.');
  const timeline = value as RecipeRecordingTimelineDocument;
  const root = input.videoPath.slice(0, input.videoPath.length - timeline.videoPath.length);
  const trace = await input.readJson(`${root}trace.json`);
  const model = createEvidenceReviewModel({
    context: input.context,
    artifactPrefix: root,
    recordings: [{ videoPath: input.videoPath, videoDigest: input.videoDigest, timeline, trace }],
  });
  if (model.errors.length) throw new Error(model.errors.join('; '));
  return model;
}

export interface EvidenceReviewReport {
  path: string;
  body: string;
  caption: string;
}

/** Read only the selected report and refuse bytes outside the retained output snapshot. */
export async function readEvidenceReviewReport(
  model: EvidenceReviewModel,
  readBytes: (path: string) => Promise<Uint8Array>,
): Promise<EvidenceReviewReport> {
  const selected = model.selectReport();
  const file = selected?.artifacts[0];
  if (!file) throw new Error(model.errors.join('; ') || 'The retained report is unavailable.');
  const expected = model.report?.artifactManifest.find((entry) => entry.path === file.path)?.sha256;
  if (!expected) throw new Error('The retained report has no byte digest.');
  const bytes = await readBytes(file.path);
  if (bytesToHex(sha256(bytes)) !== expected.replace(/^sha256:/u, ''))
    throw new Error('Report bytes no longer match the reviewed snapshot.');
  return { path: file.path, body: new TextDecoder().decode(bytes), caption: selected.caption };
}
