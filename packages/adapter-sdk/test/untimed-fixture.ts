import assert from 'node:assert/strict';

import { isRecord, type RecordedEvidencePackageInput } from '@farmslot/protocol';

/** A retained original whose capture did not produce a timeline or AC-bound screenshots. */
export function untimedRecordingFixture(
  value: RecordedEvidencePackageInput,
): RecordedEvidencePackageInput {
  const input = structuredClone(value);
  const timelinePaths = new Set(Object.keys(input.timelines));
  input.timelines = {};
  assert.ok(input.claims);
  input.claims.recording.segments = input.claims.recording.segments.map(
    ({ timelinePath: _timelinePath, ...segment }) => segment,
  );
  const videos = input.claims.recording.segments.map(({ videoPath }) => videoPath);
  input.claims.criteria = input.claims.criteria.map((claim) => ({
    ...claim,
    timing: 'untimed',
    evidence: videos,
  }));
  assert.ok(input.artifactPaths);
  input.artifactPaths = input.artifactPaths.filter((path) => !timelinePaths.has(path));
  if (isRecord(input.manifest) && Array.isArray(input.manifest.artifacts)) {
    const entries = input.manifest.artifacts.filter(
      (file) => !isRecord(file) || !timelinePaths.has(String(file.path)),
    );
    input.manifest.artifacts = entries;
    for (const file of entries) {
      if (isRecord(file) && file.type === 'screenshot') {
        delete file.nodeId;
        delete file.capture;
        if (isRecord(file.metadata)) delete file.metadata.recordedEvidence;
      }
      if (isRecord(file) && file.type === 'video') {
        delete file.timelinePath;
        file.timelineUnavailableReason = 'Capture did not retain measured timestamps.';
      }
    }
  }
  return input;
}
