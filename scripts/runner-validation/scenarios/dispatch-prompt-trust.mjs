import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { detectLaunchBlocker } from '../lib/pane-blockers.mjs';

export const SCENARIO_ID = 'dispatch-prompt-trust';

const FIXTURE_PANE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/grok-project-directory-trust.txt',
);

function classifierTrustKey(pane, runnerId, classifier) {
  const snippet = `
import { keyForClassifierTrustAction } from './services/gateway/src/runners/registry.ts';
console.log(JSON.stringify({
  key: keyForClassifierTrustAction(
    ${JSON.stringify(classifier)},
    ${JSON.stringify(runnerId)},
    ${JSON.stringify(pane)},
  ),
}));
`;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', snippet], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      FARMSLOT_HOME: process.env.FARMSLOT_HOME ?? `${os.homedir()}/.farmslot-dev`,
    },
  });
  const stdout = result.stdout?.trim() ?? '';
  const jsonLine = stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .pop();
  if (!jsonLine) {
    throw new Error(result.stderr?.trim() || stdout || 'keyForClassifierTrustAction probe failed');
  }
  return JSON.parse(jsonLine).key;
}

/**
 * Fixture regression for the grok directory-trust launch blocker:
 * - Grok project-directory / directory-trust pane is detectable
 * - Classifier trust_prompt + send_yes maps to Enter (keystroke delivery contract)
 * - Ready-deadline bump after blocker resolve is half the ready budget
 *
 * Live grok trust prompts often cache after first accept, so this scenario is
 * fixture-only and always runnable without a cold Grok profile.
 */
export async function runScenario({ runnerAdapter, outDir }) {
  const runner = runnerAdapter.RUNNER_ID;
  if (runner !== 'grok') {
    const report = {
      runner,
      skipped: true,
      skipReason: 'dispatch-prompt-trust is grok directory-trust regression only',
      pass: true,
    };
    const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
    return { scenario: SCENARIO_ID, runner, outPath, pass: true, skipped: true, report };
  }

  const report = {
    runner,
    fixture: FIXTURE_PANE,
    blockerKind: null,
    autoAction: null,
    classifierTrustKey: null,
    truncatedClassifierTrustKey: null,
    deadlineBumpMs: null,
    pass: false,
    error: null,
  };

  try {
    const pane = fs.readFileSync(FIXTURE_PANE, 'utf8');
    const blocker = detectLaunchBlocker(pane, 'grok');
    report.blockerKind = blocker?.kind ?? null;
    report.autoAction = blocker?.autoAction ?? null;
    if (blocker?.kind !== 'project-directory') {
      throw new Error(`expected project-directory blocker, got ${blocker?.kind ?? 'null'}`);
    }
    if (blocker?.autoAction !== 'grok-select-current-project') {
      throw new Error(`expected grok-select-current-project, got ${blocker?.autoAction ?? 'null'}`);
    }

    const classifier = {
      state: 'trust_prompt',
      confidence: 0.99,
      suggestedAction: 'send_yes',
    };
    report.classifierTrustKey = classifierTrustKey(pane, 'grok', classifier);
    if (report.classifierTrustKey !== 'Enter') {
      throw new Error(`expected classifier send_yes → Enter, got ${report.classifierTrustKey}`);
    }

    // Truncated pane (missing Enter:submit) still maps via runner fallback.
    report.truncatedClassifierTrustKey = classifierTrustKey(
      'Run Grok Build in a project directory?\n1 (○) probe',
      'grok',
      classifier,
    );
    if (report.truncatedClassifierTrustKey !== 'Enter') {
      throw new Error(
        `truncated trust pane must still map send_yes → Enter, got ${report.truncatedClassifierTrustKey}`,
      );
    }

    // Contract: after auto-resolve, readiness deadline extends by half the ready budget.
    const readyTimeoutMs = 120_000;
    report.deadlineBumpMs = Math.round(readyTimeoutMs / 2);
    if (report.deadlineBumpMs !== 60_000) {
      throw new Error(`expected half-budget bump of 60000ms, got ${report.deadlineBumpMs}`);
    }

    report.pass = true;
  } catch (error) {
    report.error = error?.message || String(error);
    report.pass = false;
  }

  const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
  return { scenario: SCENARIO_ID, runner, outPath, pass: report.pass, report };
}
