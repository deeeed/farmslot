import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type {
  EvidenceStillFormat,
  RecipeArtifactManifestEntry,
  RecipeRecordingTimelineDocument,
  RecordingSegmentRef,
} from '@farmslot/protocol';

import { copyFileWithinRoots, digestFileWithinRoot } from '../core/path.js';

import type { ProofTraceEntry } from './assertions.js';
import { publishEvidenceStill } from './still-format.js';

const exec = promisify(execFile);

/** Derive a still from an original decoded frame, never a replacement native snapshot. */
export async function materializeEvidenceStill(
  artifactsDir: string,
  segment: RecordingSegmentRef,
  timeline: RecipeRecordingTimelineDocument,
  traceIndex: number,
  trace: readonly ProofTraceEntry[],
  format: EvidenceStillFormat,
): Promise<RecipeArtifactManifestEntry | undefined> {
  const marker = timeline.markers.find((entry) => entry.traceIndex === traceIndex);
  if (!marker) return undefined;
  const frameMs = timeline.framesMs
    .filter((time) => time >= marker.startRangeMs[0] && time <= marker.endRangeMs[1])
    .at(-1);
  if (frameMs === undefined) return undefined;
  const relative = `stills/recorded-${traceIndex}.png`;
  const staging = await mkdtemp(path.join(os.tmpdir(), 'evidence-still-'));
  try {
    if ((await digestFileWithinRoot(artifactsDir, segment.videoPath)) !== segment.videoDigest)
      throw new Error('Original recording bytes changed before still derivation.');
    await exec(
      process.env.FFMPEG_PATH ?? 'ffmpeg',
      [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        String(frameMs / 1000),
        '-i',
        path.join(artifactsDir, segment.videoPath),
        '-frames:v',
        '1',
        path.join(staging, 'frame.png'),
      ],
      { timeout: 2_000, maxBuffer: 128 * 1024 },
    );
    await copyFileWithinRoots(staging, 'frame.png', artifactsDir, relative);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  const still = await publishEvidenceStill(artifactsDir, relative, format);
  return {
    path: still.path,
    type: 'screenshot',
    mimeType: still.mimeType,
    category: 'evidence',
    nodeId: trace[traceIndex]?.nodeId ?? trace[traceIndex]?.id,
    metadata: {
      recordedEvidence: {
        videoPath: segment.videoPath,
        videoDigest: segment.videoDigest,
        traceIndex,
        frameMs,
      },
    },
    sha256: (await digestFileWithinRoot(artifactsDir, still.path)).slice(7),
  };
}
