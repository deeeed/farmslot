#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

import {
  buildTimingArtifact,
  finish,
  isMainModule,
  renderTimingSummary,
  runTimedSteps,
  writeTimingArtifact,
} from './lib/step-timing.mjs';

export const TIMINGS_ARTIFACT_NAME = 'quality-steps.json';

export const STEPS = [
  ['format', ['yarn', 'format:check']],
  ['ESLint cache guard tests', ['node', '--test', 'scripts/quality/check-eslint-ratchet.test.mjs']],
  ['lint', ['yarn', 'lint']],
  ['workspace structure', ['yarn', 'quality:structure']],
  ['workspace changelogs', ['yarn', 'quality:changelogs']],
  ['import boundaries', ['yarn', 'quality:imports']],
  ['large-file warning', ['yarn', 'quality:large-files']],
  ['type-escape lint', ['yarn', 'lint:type-escapes']],
  ['review-loop validation contract', ['yarn', 'quality:review-loop']],
  ['package/service workspace quality', ['yarn', 'quality:workspaces']],
  ['theme quality', ['yarn', 'workspace', '@farmslot/theme', 'quality']],
  ['recipe harness quality', ['yarn', 'workspace', '@farmslot/recipe-harness', 'quality']],
  ['protocol tests', ['yarn', 'test:protocol']],
  ['worker template contract', ['node', 'scripts/quality/worker-terminal-contract.test.cjs']],
  [
    'conventional commit guard tests',
    ['node', '--test', 'scripts/quality/check-conventional-commits.test.mjs'],
  ],
  [
    'package publisher guard tests',
    ['node', '--test', 'scripts/quality/check-farmslot-package-readiness.test.mjs'],
  ],
  [
    'single-canonical worker scripts',
    ['node', '--test', 'scripts/quality/single-canonical-worker-scripts.test.mjs'],
  ],
  [
    'role template mark guard',
    ['node', '--test', 'scripts/quality/role-template-mark-guard.test.mjs'],
  ],
  [
    'quality gate instrumentation tests',
    ['node', '--test', 'scripts/quality/run-quality.test.mjs'],
  ],
  [
    'workspace quality instrumentation tests',
    ['node', '--test', 'scripts/quality/run-workspace-quality.test.mjs'],
  ],
  ['pre-push path filter tests', ['node', '--test', 'scripts/quality/prepush-quality.test.mjs']],
  ['tsx test partition tests', ['node', '--test', 'scripts/quality/run-tsx-tests.test.mjs']],
  ['worker template lint', ['node', 'scripts/quality/check-worker-template-contract.mjs']],
  ['template variable docs', ['node', 'scripts/quality/check-template-variables-docs.mjs']],
  ['shell script tests', ['bash', 'scripts/tests/run-shell-tests.sh']],
  ['project hook conformance tests', ['yarn', 'test:project-hooks']],
  ['recipe harness tests', ['yarn', 'test:recipe-harness']],
  ['ui tests', ['yarn', 'test:ui']],
  ['recipe operational gates', ['yarn', 'test:recipe-operational-gates']],
  ['companion tests', ['yarn', '--cwd', 'apps/companion', 'test:lib']],
  ['typecheck', ['yarn', 'typecheck']],
  ['package readiness', ['yarn', 'packages:publish:check']],
  ['docs build', ['yarn', 'docs:build']],
];

export function runQualitySteps(steps = STEPS, options = {}) {
  return runTimedSteps(steps, { prefix: 'quality', spawn: spawnSync, ...options });
}

export function qualitySummaryLines(records, failure) {
  return renderTimingSummary({ prefix: 'quality', records, failure });
}

export function qualityTimingArtifact(records, failure) {
  return buildTimingArtifact({ kind: 'quality-steps', records, failure });
}

function main() {
  const { records, failure } = runQualitySteps();
  for (const line of qualitySummaryLines(records, failure)) console.log(line);
  const artifactPath = writeTimingArtifact(
    TIMINGS_ARTIFACT_NAME,
    qualityTimingArtifact(records, failure),
  );
  if (artifactPath) console.log(`[quality] timings artifact: ${artifactPath}`);
  finish(failure ? failure.status : 0);
}

if (isMainModule(import.meta.url)) main();
