import { classifyFailureText } from '../../core/failure-patterns.js';

import {
  CHECK_FOR_LABEL,
  type TriageLabel,
  type TriagePacket,
  type TriagePrediction,
} from './types.js';

export const BASELINE_VERSION = 'failure-triage-baselines-v1';
export const PATTERN_MAPPING: Record<string, TriageLabel> = {
  'devserver-crashed': 'environment',
  'network-timeout': 'unclear',
  'transient-network': 'unclear',
  'fixture-env-drift': 'environment',
  'flaky-test': 'unclear',
};
function prediction(label: TriageLabel, evidenceIds: string[]): TriagePrediction {
  return { label, nextCheck: CHECK_FOR_LABEL[label], evidenceIds };
}
export function existingBaseline(packet: TriagePacket): TriagePrediction {
  const match = classifyFailureText(packet.evidence.map((e) => e.text).join('\n'));
  const label = match ? (PATTERN_MAPPING[match.patternId] ?? 'unclear') : 'unclear';
  return prediction(
    label,
    match
      ? packet.evidence
          .filter((e) => e.text.includes(match.matchedText))
          .map((e) => e.id)
          .slice(0, 1)
      : [],
  );
}
// Frozen generic cues, not per-case IDs or reference labels. Multiple causes abstain.
const CUES: Array<[TriageLabel, RegExp]> = [
  ['environment', /ECONNREFUSED|ENOENT|missing required .*variable|wrong working directory/i],
  [
    'dependencies',
    /ERR_MODULE_NOT_FOUND|Cannot find (?:package|module)|does not provide an export|lockfile.*(?:mismatch|checksum)|requires version/i,
  ],
  ['external_service', /HTTP (?:401|403|429|50[234])|upstream.*invalid JSON/i],
  [
    'missing_evidence',
    /required (?:artifact|evidence|report).*missing|artifact digest mismatch|validation.*not.run/i,
  ],
  [
    'test_harness',
    /fixture-only|locator.*(?:missing|not found)|mock.*(?:missing|undefined)|deadline.*0ms/i,
  ],
  ['implementation', /source-only repair|module body changed.*restored/i],
];
export function cueBaseline(packet: TriagePacket): TriagePrediction {
  const hits = CUES.flatMap(([label, re]) => {
    const entry = packet.evidence.find((e) => re.test(e.text));
    return entry ? [{ label, id: entry.id }] : [];
  });
  return hits.length === 1 ? prediction(hits[0].label, [hits[0].id]) : prediction('unclear', []);
}
