import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '../../src/contracts/runs.js';
import {
  sanitizeRunForBundleExport,
  stripRunnerSessionArchives,
} from '../../src/runs/portable-bundle.js';

function runWithArchive(): Run {
  return {
    id: 'run-1',
    familyId: 'family-1',
    lane: 'production',
    variant: null,
    flowType: 'dev',
    mode: 'autonomous',
    status: 'done',
    project: 'demo-farm',
    ticketOrPr: 'T-1',
    steps: [],
    decisions: [],
    metrics: {
      nudgeCount: 0,
      model: 'opus',
      runner: 'claude',
      runnerSessionArchive: {
        status: 'captured',
        kind: 'jsonl',
        relativeDir: 'session-archives/run-1/dev',
      },
    },
    agentContexts: [
      {
        id: 'dev',
        role: 'dev',
        label: 'Worker',
        status: 'complete',
        slotId: 'slot-1',
        runId: 'run-1',
        runnerSessionArchive: {
          status: 'captured',
          kind: 'jsonl',
          relativeDir: 'session-archives/run-1/dev',
        },
      },
    ],
    createdAt: '2026-09-12T00:00:00.000Z',
    updatedAt: '2026-09-12T00:00:00.000Z',
  };
}

test('stripRunnerSessionArchives drops recycle snapshot pointers', () => {
  const stripped = stripRunnerSessionArchives(runWithArchive());
  assert.equal(stripped.metrics.runnerSessionArchive, undefined);
  assert.equal(stripped.agentContexts?.[0]?.runnerSessionArchive, undefined);
});

test('sanitizeRunForBundleExport never keeps archive pointers', () => {
  const sanitized = sanitizeRunForBundleExport(runWithArchive(), 'reference');
  assert.equal(sanitized.metrics.runnerSessionArchive, undefined);
  assert.equal(sanitized.agentContexts?.[0]?.runnerSessionArchive, undefined);
});
