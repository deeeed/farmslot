import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

export const SCENARIO_ID = 'workspace-review-lifecycle';
const exec = promisify(execFile);

export async function runScenario({ runnerAdapter, outDir, explicit }) {
  const runner = runnerAdapter.RUNNER_ID;
  if (!explicit) return { scenario: SCENARIO_ID, runner, pass: true, skipped: true };
  const report = { runner, pass: false, checks: [], error: null };
  try {
    assert.equal(runner, 'codex', 'This live fixture requires the read-only workspace capability');
    const evidence = path.join(outDir, `${SCENARIO_ID}-${Date.now()}`);
    const result = await exec(
      'yarn',
      ['exec', 'tsx', 'scripts/e2e-workspace-review-lifecycle.mts', 'recipe', evidence],
      { cwd: ROOT, timeout: 6_000_000, maxBuffer: 2 * 1024 * 1024 },
    );
    report.checks.push({
      name: 'production-gateway-lifecycle-recipe',
      evidence,
      output: result.stdout,
    });
    report.pass = true;
  } catch (error) {
    report.error = String(error);
  }
  const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
  return { scenario: SCENARIO_ID, runner, pass: report.pass, outPath, report };
}
