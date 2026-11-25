import { PREPARE_PINNED_KINDS, type PreparePinnedKind } from '@farmslot/protocol';

import type { RawProjectJson } from '../../core/index.js';

/**
 * Pinned prepare: a comparison run with a start commit must run on a build of that
 * commit, or fail before its worker starts. The project's preflight installs the
 * build and reports what it installed in this receipt, in the slot runtime dir.
 */
export const PREPARE_ARTIFACT_RECEIPT = 'prepare-artifact.json';

/** The build a pinned prepare installed, as its receipt reported it. */
export interface PinnedPrepareArtifact {
  kind: PreparePinnedKind;
  baseSha: string;
  runId?: string;
  revision: string;
  platform: string;
}

/**
 * A project takes part in pinned prepare when it can install a build of a given
 * commit (it declares an `artifact_check` probe) or says how (`pinned_profiles`).
 * Its comparison runs with a start commit are then pinned; other projects prepare
 * them as before.
 */
export function projectPinsPrepare(projectJson: RawProjectJson): boolean {
  return (
    Boolean(projectJson.hooks?.artifact_check) || projectJson.prepare?.pinned_profiles !== undefined
  );
}

/**
 * The profile a pinned run prepares with: the requested one if the platform's list
 * has it, otherwise the list's first entry. Validation guarantees each listed
 * profile declares a pinned_kind.
 */
export function resolvePinnedProfile(
  projectJson: RawProjectJson,
  platform: string,
  requested?: string,
): { name: string; kind: PreparePinnedKind } {
  const pinned = projectJson.prepare?.pinned_profiles;
  if (pinned === undefined) {
    throw new Error(
      'The project declares artifact_check but no prepare.pinned_profiles, so a pinned comparison run has no build to install',
    );
  }
  const list = Array.isArray(pinned) ? pinned : pinned[platform];
  if (!list?.length) {
    throw new Error(`prepare.pinned_profiles has no entry for platform '${platform}'`);
  }
  const name = requested ?? list[0];
  if (!list.includes(name)) {
    throw new Error(
      `A pinned comparison run cannot prepare with profile '${name}': it is not in prepare.pinned_profiles for ${platform} (allowed: ${list.join(', ')})`,
    );
  }
  const kind = PREPARE_PINNED_KINDS.find(
    (candidate) => candidate === projectJson.prepare?.profiles?.[name]?.pinned_kind,
  );
  if (!kind) throw new Error(`Pinned profile '${name}' declares no pinned_kind`);
  return { name, kind };
}

const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * The reason a receipt gives for refusing the build, flattened to one line, or
 * undefined when the receipt is not a refusal. The harness message ends in a
 * "Next:" hint that alone would hide the cause.
 */
export function receiptRefusal(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const receipt = parsed as Record<string, unknown>;
  if (receipt.status !== 'failed') return undefined;
  const reason =
    typeof receipt.reason === 'string'
      ? receipt.reason
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .join('; ')
      : '';
  return reason || 'the preflight gave no reason';
}

/**
 * Check the receipt a pinned preflight wrote against the run. Every mismatch fails
 * the prepare: a build that cannot be shown to match the run's start commit must
 * not reach a worker. A refusal carries the harness reason flattened to one line,
 * since it ends in a "Next:" hint that alone would hide the cause.
 */
export function checkPrepareArtifactReceipt(
  raw: string | null,
  expected: { kind: PreparePinnedKind; baseSha: string; platform: string },
): PinnedPrepareArtifact {
  if (raw === null) {
    throw new Error(
      `The pinned preflight wrote no ${PREPARE_ARTIFACT_RECEIPT}: it must report the build it installed`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${PREPARE_ARTIFACT_RECEIPT} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${PREPARE_ARTIFACT_RECEIPT} is not a receipt object`);
  }
  const receipt = parsed as Record<string, unknown>;
  const refusal = receiptRefusal(raw);
  if (refusal) throw new Error(`Pinned build refused: ${refusal}`);
  if (receipt.status !== 'ok') {
    throw new Error(`${PREPARE_ARTIFACT_RECEIPT} status must be ok or failed`);
  }
  if (receipt.kind !== expected.kind) {
    throw new Error(
      `${PREPARE_ARTIFACT_RECEIPT} receipt kind '${String(receipt.kind)}' does not match profile kind '${expected.kind}'`,
    );
  }
  if (receipt.platform !== expected.platform) {
    throw new Error(
      `${PREPARE_ARTIFACT_RECEIPT} receipt platform '${String(receipt.platform)}' does not match the slot platform '${expected.platform}'`,
    );
  }
  if (receipt.baseSha !== expected.baseSha) {
    throw new Error(
      `${PREPARE_ARTIFACT_RECEIPT} reports a build installed for base ${String(receipt.baseSha)}, not the run's start ${expected.baseSha}`,
    );
  }
  if (typeof receipt.revision !== 'string' || !FULL_SHA.test(receipt.revision)) {
    throw new Error(`${PREPARE_ARTIFACT_RECEIPT} revision must be a 40-hex commit`);
  }
  const runId = typeof receipt.runId === 'string' && receipt.runId ? receipt.runId : undefined;
  if (expected.kind === 'runway' && !runId) {
    throw new Error(`${PREPARE_ARTIFACT_RECEIPT}: a runway receipt must name its run id`);
  }
  return {
    kind: expected.kind,
    baseSha: expected.baseSha,
    ...(runId ? { runId } : {}),
    revision: receipt.revision,
    platform: expected.platform,
  };
}
