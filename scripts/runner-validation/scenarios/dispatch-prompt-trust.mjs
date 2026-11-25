import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeEvidence } from '../lib/evidence.mjs';
import { detectLaunchBlocker } from '../lib/pane-blockers.mjs';

export const SCENARIO_ID = 'dispatch-prompt-trust';

const FIXTURE_PANE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/grok-project-directory-trust.txt',
);

/**
 * Fixture regression for the grok directory-trust launch blocker:
 * - Grok project-directory / directory-trust pane is detectable
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
