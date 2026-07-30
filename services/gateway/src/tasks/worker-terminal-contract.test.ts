import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveWorkerTerminalContract,
  withTerminalReportPath,
} from './worker-terminal-contract.js';

test('withTerminalReportPath scopes reviewer completion artifacts to its context', () => {
  const base = resolveWorkerTerminalContract(undefined, 'self-review');
  const scoped = withTerminalReportPath(base, 'artifacts/review-feedback.rev8-claude.md');

  for (const command of ['complete', 'no-change'] as const) {
    assert.equal(scoped.commands[command].report, 'artifacts/review-feedback.rev8-claude.md');
    assert.deepEqual(scoped.commands[command].artifacts, [
      'artifacts/review-feedback.rev8-claude.md',
    ]);
  }
  assert.equal(base.commands.complete.report, 'artifacts/review-feedback.md');
});
