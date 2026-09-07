import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { PressureAdmissionDecision, PressureAdmissionEvidence } from '@farmslot/protocol';

import { stripAnsi } from '../colors.js';

import { renderAdmissionControl, renderPressureAdmission } from './dispatch.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const ARTIFACT_DIR = path.join(REPO_ROOT, 'artifacts');

const GENERATION = 'macwork|gen-a|3|2026-08-21T09:59:30.000Z';

function evidence(overrides: Partial<PressureAdmissionEvidence> = {}): PressureAdmissionEvidence {
  return {
    machine: 'macwork',
    generation: GENERATION,
    evaluatedAt: '2026-08-21T10:00:00.000Z',
    samples: [
      {
        collectedAt: '2026-08-21T09:58:30.000Z',
        cpu: 0.96,
        memory: 0.41,
        disk: 0.5,
        load1: 0.6,
        critical: true,
      },
      {
        collectedAt: '2026-08-21T09:59:00.000Z',
        cpu: 0.97,
        memory: 0.42,
        disk: 0.5,
        load1: 0.6,
        critical: true,
      },
      {
        collectedAt: '2026-08-21T09:59:30.000Z',
        cpu: 0.99,
        memory: 0.44,
        disk: 0.5,
        load1: 0.7,
        critical: true,
      },
    ],
    consecutiveCriticalSamples: 3,
    requiredConsecutiveCriticalSamples: 3,
    staleAfterMs: 150_000,
    latestSampleAt: '2026-08-21T09:59:30.000Z',
    ...overrides,
  };
}

const rejected: PressureAdmissionDecision = {
  outcome: 'rejected',
  machine: 'macwork',
  state: 'sustained-critical',
  code: 'PRESSURE_SUSTAINED_CRITICAL',
  reason:
    'Machine macwork has been critical for 3 consecutive samples (threshold 3); new dispatches are rejected until pressure recedes or an operator overrides this one dispatch.',
  causes: [
    {
      process: 'node',
      processCount: 6,
      cpuPercent: 240,
      rssBytes: 4 * 1073741824,
      classification: 'retained',
      confidence: 'high',
      slotId: 'macwork-ff-2',
      cleanupEligible: true,
    },
    {
      process: 'ffmpeg',
      processCount: 1,
      cpuPercent: 180,
      rssBytes: 1073741824,
      classification: 'manual',
      confidence: 'medium',
      cleanupEligible: false,
    },
  ],
  evidence: evidence(),
  overridable: true,
};

const overridden: PressureAdmissionDecision = {
  outcome: 'admitted',
  machine: 'macwork',
  state: 'override',
  evidence: evidence(),
  override: {
    machine: 'macwork',
    pressureGeneration: GENERATION,
    reason: 'single urgent hotfix approved by operator',
    principalId: 'principal-arthur',
    requestedAt: '2026-08-21T10:00:05.000Z',
    scope: 'single-dispatch',
  },
};

let rejectedText = '';
let overriddenText = '';

test('CLI renders the backend rejection with samples, causes, and override syntax', () => {
  rejectedText = renderPressureAdmission(rejected).map(stripAnsi).join('\n');
  assert.match(rejectedText, /PRESSURE_SUSTAINED_CRITICAL/);
  assert.match(rejectedText, /3\/3 consecutive critical/);
  assert.match(rejectedText, /node ×6/);
  assert.match(rejectedText, /explains pressure; not a cleanup target/);
  assert.match(rejectedText, /--pressure-machine macwork/);
  assert.match(rejectedText, /--pressure-generation/);
  assert.match(rejectedText, /--pressure-override-reason/);
  assert.match(rejectedText, /farmslot dispatch preview/);
});

test('CLI renders an accepted one-dispatch override with its audit principal', () => {
  overriddenText = renderPressureAdmission(overridden).map(stripAnsi).join('\n');
  assert.match(overriddenText, /override on macwork/);
  assert.match(overriddenText, /accepted for this dispatch only/);
  assert.match(overriddenText, /principal-arthur/);
});

test('CLI never renders threshold logic of its own for admitted machines', () => {
  const green: PressureAdmissionDecision = {
    outcome: 'admitted',
    machine: 'mini',
    state: 'green',
    evidence: evidence({ machine: 'mini', samples: [], consecutiveCriticalSamples: 0 }),
  };
  const text = renderPressureAdmission(green).map(stripAnsi).join('\n');
  assert.match(text, /green on mini/);
  assert.doesNotMatch(text, /Override:/);
});

test('CLI status reports the EFFECTIVE state, not just the stored flag', () => {
  // The exact trap this renderer used to fall into: env override on, durable
  // state at its off default. Dispatches ARE being refused.
  const overridden = renderAdmissionControl({
    enabled: false,
    updatedAt: null,
    updatedBy: null,
    envOverride: 'refuse',
  })
    .map(stripAnsi)
    .join('\n');
  assert.match(overridden, /Pressure admission: enforcing/);
  assert.match(overridden, /FARMSLOT_DISPATCH_PRESSURE_ADMISSION=refuse/);
  assert.match(overridden, /Stored setting: disabled \(not in effect\)/);
  assert.doesNotMatch(overridden, /NOT pressure-gated/);

  // And the mirror image: stored setting enabled, env override turning it off.
  const suppressed = renderAdmissionControl({
    enabled: true,
    updatedAt: '2026-09-01T00:00:00.000Z',
    updatedBy: 'principal-arthur',
    envOverride: 'off',
  })
    .map(stripAnsi)
    .join('\n');
  assert.match(suppressed, /Pressure admission: DISABLED/);
  assert.match(suppressed, /Stored setting: enabled \(not in effect\)/);
  assert.match(suppressed, /NOT pressure-gated/);
});

test('CLI status with no env override reports the stored setting as the source', () => {
  const stored = renderAdmissionControl({ enabled: false, updatedAt: null, updatedBy: null })
    .map(stripAnsi)
    .join('\n');
  assert.match(stored, /Pressure admission: DISABLED/);
  assert.match(stored, /Source: stored gateway setting/);
  assert.match(stored, /gateway default: off/);
  assert.doesNotMatch(stored, /Stored setting:/);
});

after(() => {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(
    path.join(ARTIFACT_DIR, 'cli-pressure-admission.txt'),
    [
      '# CLI pressure admission rendering (MANUAL-000109)',
      '',
      '## Rejected example (dispatch preview against a sustained-critical machine)',
      '',
      rejectedText,
      '',
      '## Overridden example (run create with a valid current one-dispatch override)',
      '',
      overriddenText,
      '',
    ].join('\n'),
  );
});
