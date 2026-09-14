import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ROOT } from '../lib/common.mjs';

import { runScenario as runNativeSessionSmoke } from './native-session-smoke.mjs';

export const SCENARIO_ID = 'native-additional-runners';

/** The same production session suite, with honest standalone capability assertions. */
export async function runScenario(options) {
  const runner = options.runnerAdapter.RUNNER_ID;
  assert.ok(['cursor', 'grok'].includes(runner), 'Expected an additional ACP runner');
  const catalog = JSON.parse(
    execFileSync(
      process.execPath,
      [
        path.join(ROOT, 'apps/command-center/scripts/cdp.mjs'),
        'gateway',
        'native.session.catalog',
        '{}',
      ],
      { cwd: ROOT, encoding: 'utf8', env: process.env },
    ),
  );
  const entry = catalog.runners.find((candidate) => candidate.runner === runner);
  assert.ok(entry, 'Native catalog omitted the enabled runner');
  assert.equal(entry.supportsWorkers, false, 'Unproven worker transport must remain unavailable');
  assert.equal(entry.supportsQueuedWorkers, false);
  assert.deepEqual(entry.modes, ['default']);
  assert.ok(
    entry.models.includes(entry.defaultModel),
    'Catalog default must be a selectable native model ID',
  );
  let modeRejected = false;
  try {
    execFileSync(
      process.execPath,
      [
        path.join(ROOT, 'apps/command-center/scripts/cdp.mjs'),
        'gateway',
        'native.session.create',
        JSON.stringify({ runner, cwd: ROOT, mode: 'plan' }),
      ],
      { cwd: ROOT, encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    const stderr = String(error.stderr ?? '');
    assert.match(stderr, /"ok":false/, 'Transport failure is not a mode rejection');
    assert.match(stderr, /does not support this interaction mode/);
    modeRejected = true;
  }
  assert.equal(modeRejected, true, 'Unproven plan mode was accepted');
  return runNativeSessionSmoke({
    ...options,
    model: options.model ?? entry.defaultModel,
    deniedTurnStatus: runner === 'grok' ? 'interrupted' : 'completed',
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runner = process.argv[2];
  const result = await runScenario({
    runnerAdapter: { RUNNER_ID: runner },
    timeoutMs: 300_000,
    outDir: path.resolve(process.argv[3] ?? 'temp/native-validation/g005-gateway/evidence'),
  });
  console.log(
    JSON.stringify({
      scenario: result.scenario,
      runner: result.runner,
      outPath: result.outPath,
      pass: result.pass,
      error: result.report?.error,
    }),
  );
  if (result?.pass === false) process.exitCode = 1;
}
