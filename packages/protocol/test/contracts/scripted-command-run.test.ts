import assert from 'node:assert/strict';
import test from 'node:test';

import { isArtifactOnlyScriptedCommandRun } from '../../src/contracts/runs.js';

const command = { mode: 'command' as const, commandRef: 'nightly-device-build' };

test('only an artifact-only scripted command run is judged by its command result', () => {
  const run = {
    scripted: command,
    completionPolicy: 'artifact-only' as const,
    metrics: { runner: 'scripted' },
  };
  assert.equal(isArtifactOnlyScriptedCommandRun(run), true);
  for (const other of [
    { ...run, completionPolicy: undefined },
    { ...run, metrics: { runner: 'codex' } },
    { ...run, scripted: { mode: 'scenario' as const, scenario: 'success' as const } },
    { ...run, scripted: undefined },
  ])
    assert.equal(isArtifactOnlyScriptedCommandRun(other), false);
});
