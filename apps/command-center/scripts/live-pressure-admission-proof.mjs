#!/usr/bin/env node
// Live sustained-pressure admission proof (MANUAL-000109).
//
// Runs against the PRODUCTION gateway (FARMSLOT_GATEWAY, default from
// .env.ports) through the committed cdp.mjs gateway helper. Creates
// preview/rejection/override evidence WITHOUT launching anything and proves
// unrelated run/resource generations stay unchanged.
//
// Requires the validation-only fixture on the gateway process:
//   FARMSLOT_PRESSURE_VALIDATION_FIXTURE_MACHINE=<machine>
// and a free slot on that machine (the dedicated validation target). The
// fixture cannot be enabled from any RPC input.
//
// Usage:
//   node scripts/live-pressure-admission-proof.mjs [--machine farmslot-demo] [--slot demo-ff-1] [--project farmslot-farm]

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const ARTIFACT_DIR = path.join(REPO_ROOT, 'artifacts');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const MACHINE = arg('machine', 'farmslot-demo');
const SLOT = arg('slot', 'demo-ff-1');
const PROJECT = arg('project', 'farmslot-farm');

function gateway(method, params = {}) {
  const out = execFileSync(
    'node',
    [path.join(HERE, 'cdp.mjs'), 'gateway', method, JSON.stringify(params)],
    {
      encoding: 'utf-8',
      maxBuffer: 128 * 1024 * 1024,
      // dispatch.candidates pays cold-cache branch refreshes over SSH.
      env: {
        ...process.env,
        FARMSLOT_RPC_TIMEOUT_MS: process.env.FARMSLOT_RPC_TIMEOUT_MS ?? '60000',
      },
    },
  );
  return JSON.parse(out);
}

/** Stable digest of everything a dispatch could mutate: run identity/status
 * and per-slot ownership/lifecycle. The proof requires it identical
 * before/after, excluding only the dedicated validation slot. */
function mutationView() {
  const runs = gateway('run.list', { limit: 500 });
  const fleet = gateway('fleet.status', {}).fleet;
  return {
    runs: Object.fromEntries(
      (runs.runs ?? runs).map((run) => [run.id, `${run.status}|${run.slotId}|${run.updatedAt}`]),
    ),
    slots: Object.fromEntries(
      fleet.slots
        .filter((slot) => slot.slot !== SLOT)
        .map((slot) => [
          slot.slot,
          `${slot.lifecycle}|${slot.agent}|${slot.currentRunId ?? ''}|${slot.branch}`,
        ]),
    ),
  };
}

function diffViews(before, after) {
  const changed = [];
  for (const key of ['runs', 'slots']) {
    const beforeMap = before[key];
    const afterMap = after[key];
    for (const id of new Set([...Object.keys(beforeMap), ...Object.keys(afterMap)])) {
      if (beforeMap[id] !== afterMap[id]) {
        changed.push({ kind: key, id, before: beforeMap[id] ?? null, after: afterMap[id] ?? null });
      }
    }
  }
  return changed;
}

const before = mutationView();

// 1. Candidates: the fixture machine's free rows must be pressure-rejected.
const candidates = gateway('dispatch.candidates', { project: PROJECT });
const slotRow = candidates.candidates.find((candidate) => candidate.slotId === SLOT);
if (!slotRow) throw new Error(`slot ${SLOT} not present in dispatch.candidates`);
if (
  slotRow.pressureAdmission?.outcome !== 'rejected' ||
  slotRow.ineligibilitySource !== 'pressure'
) {
  throw new Error(`slot ${SLOT} is not pressure-rejected — is the validation fixture enabled?`);
}

// 2. Explicit-slot preview: same backend rejection with generation identity.
const previewParams = {
  project: PROJECT,
  flowType: 'fix-bug',
  ticketOrPr: 'MANUAL-000109',
  slotId: SLOT,
};
const rejectedPreview = gateway('dispatch.preview', previewParams);
const rejection = rejectedPreview.pressureAdmission;
if (rejection?.outcome !== 'rejected' || rejection.code !== 'PRESSURE_SUSTAINED_CRITICAL') {
  throw new Error(`expected sustained rejection on preview, got ${JSON.stringify(rejection)}`);
}
const generation = rejection.evidence.generation;
if (!generation) throw new Error('rejected decision carries no generation to bind an override to');

// 3. Stale override: a wrong generation must fail with a fresh decision.
const staleOverridePreview = gateway('dispatch.preview', {
  ...previewParams,
  pressureOverride: {
    machine: MACHINE,
    pressureGeneration: `${generation}-stale`,
    reason: 'live proof: deliberately stale generation',
  },
});
if (staleOverridePreview.pressureAdmission?.code !== 'PRESSURE_OVERRIDE_STALE') {
  throw new Error(
    `expected PRESSURE_OVERRIDE_STALE, got ${JSON.stringify(staleOverridePreview.pressureAdmission)}`,
  );
}

// 4. Valid current override: admitted for exactly one dispatch, audited.
const overridePreview = gateway('dispatch.preview', {
  ...previewParams,
  pressureOverride: {
    machine: MACHINE,
    pressureGeneration: generation,
    reason: 'live proof: one dispatch against the dedicated validation target',
  },
});
const admitted = overridePreview.pressureAdmission;
if (admitted?.outcome !== 'admitted' || admitted.state !== 'override') {
  throw new Error(`expected admitted override, got ${JSON.stringify(admitted)}`);
}

const after = mutationView();
const unrelatedChanges = diffViews(before, after);

// The no-mutation grep from the Acceptance Criteria, recorded verbatim.
let grepOutput = '';
let grepExit = 0;
try {
  grepOutput = execFileSync(
    'rg',
    ['-n', 'runPause|resourceCleanup|SIGSTOP|SIGTSTP', 'services/gateway/src/methods/dispatch'],
    { cwd: REPO_ROOT, encoding: 'utf-8' },
  );
} catch (error) {
  grepExit = error.status ?? 1;
  grepOutput = String(error.stdout ?? '');
}

mkdirSync(ARTIFACT_DIR, { recursive: true });
writeFileSync(
  path.join(ARTIFACT_DIR, 'live-pressure-admission-proof.json'),
  JSON.stringify(
    {
      spec: 'MANUAL-000109',
      capturedAt: new Date().toISOString(),
      gateway: process.env.FARMSLOT_GATEWAY ?? 'from .env.ports',
      validationTarget: { machine: MACHINE, slot: SLOT, project: PROJECT },
      candidateRow: {
        slotId: slotRow.slotId,
        ineligibleReason: slotRow.ineligibleReason,
        ineligibilitySource: slotRow.ineligibilitySource,
        decisionCode: slotRow.pressureAdmission.code,
      },
      rejectedPreview: rejection,
      staleOverride: staleOverridePreview.pressureAdmission,
      acceptedOverride: admitted,
      launched: false,
      generationsBefore: {
        runs: Object.keys(before.runs).length,
        slots: Object.keys(before.slots).length,
      },
      generationsAfter: {
        runs: Object.keys(after.runs).length,
        slots: Object.keys(after.slots).length,
      },
      unrelatedMutations: unrelatedChanges.length,
      unrelatedChanges,
    },
    null,
    2,
  ),
);
writeFileSync(
  path.join(ARTIFACT_DIR, 'no-existing-work-mutation.json'),
  JSON.stringify(
    {
      spec: 'MANUAL-000109',
      capturedAt: new Date().toISOString(),
      grep: {
        command:
          "rg -n 'runPause|resourceCleanup|SIGSTOP|SIGTSTP' services/gateway/src/methods/dispatch",
        exitCode: grepExit,
        matches: grepOutput.trim() === '' ? [] : grepOutput.trim().split('\n'),
      },
      runAndSlotGenerationsUnchanged: unrelatedChanges.length === 0,
      unrelatedMutations: unrelatedChanges.length,
      unrelatedChanges,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify(
    { ok: unrelatedChanges.length === 0, unrelatedMutations: unrelatedChanges.length },
    null,
    2,
  ),
);
if (unrelatedChanges.length > 0) process.exit(1);
