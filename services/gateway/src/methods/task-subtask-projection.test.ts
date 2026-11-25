import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import type { Run } from '@farmslot/protocol';

// See replay-step-nested-checklist.test.ts: mock.module replaces a module
// wholesale, so the real namespaces are spread in and only the fixtures these
// tests need are overridden.
import * as realConfig from '../core/config.js';
import * as realFleetState from '../fleet/state.js';
import * as realRunStore from '../runs/store.js';

let repoRoot = '';
// A run on the slot, for the cases whose child display depends on the owning context.
let slotRun: Run | undefined;

mock.module('../core/config.js', {
  namedExports: {
    ...realConfig,
    loadSlotVars: async () => ({
      remoteRepo: repoRoot,
      host: 'localhost',
      machine: 'local',
      sshTarget: '',
      slotId: 'slot-projection',
      projectName: 'farmslot',
    }),
  },
});

mock.module('../fleet/state.js', {
  namedExports: {
    ...realFleetState,
    loadFleetStatus: async () => ({
      slots: [{ slot: 'slot-projection', taskFile: null, currentRunId: slotRun?.id ?? null }],
    }),
  },
});

mock.module('../runs/store.js', {
  namedExports: {
    ...realRunStore,
    getRun: (id: string) => (slotRun?.id === id ? slotRun : undefined),
    listRuns: () => ({ runs: [] }),
  },
});

const { taskProgress } = await import('./task.js');
const { makeRun } = await import('./run/test-fixtures.js');

const PARENT_MARKDOWN = [
  '# Worker',
  '',
  '- [x] **1. read the ticket**',
  '- [ ] **2. run the review skill**',
  '- [ ] **3. write the report**',
  '',
].join('\n');

const CHILD_MARKDOWN = [
  '# Perps review',
  '',
  '## Rules',
  '',
  '- [ ] Never approve your own diff.',
  '',
  '## Review',
  '',
  '- [x] **1. read the diff**',
  '- [ ] **2. check the domain patterns**',
  '',
].join('\n');

interface Fixture {
  root: string;
  taskFileRel: string;
}

function writeFixture(options: {
  childStatus?: string;
  lastEventAt?: string;
  parentChecklist?: string;
  indexBody?: string;
  omitChildFiles?: boolean;
}): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gw-projection-'));
  repoRoot = root;
  const taskDirRel = path.join('.task', 'dev', 'demo');
  const taskDir = path.join(root, taskDirRel);
  mkdirSync(path.join(taskDir, 'subtasks'), { recursive: true });
  writeFileSync(path.join(taskDir, 'CHECKLIST.md'), PARENT_MARKDOWN);

  const indexBody =
    options.indexBody ??
    `${JSON.stringify({
      schemaVersion: 1,
      units: [
        {
          id: 'perps-review',
          parent: { checklist: options.parentChecklist ?? 'CHECKLIST.md', stepNumber: 2 },
          checklist: 'subtasks/perps-review.md',
          signal: 'subtasks/perps-review-SIGNAL.json',
          source: { kind: 'skill', ref: 'skills/review.md', sha256: 'aa', renderedSha256: 'bb' },
          registeredAt: '2026-09-19T09:00:00Z',
        },
      ],
    })}\n`;
  writeFileSync(path.join(taskDir, 'subtasks', 'index.json'), indexBody);

  if (!options.omitChildFiles) {
    writeFileSync(path.join(taskDir, 'subtasks', 'perps-review.md'), CHILD_MARKDOWN);
    const checkedAt = options.lastEventAt ?? new Date().toISOString();
    writeFileSync(
      path.join(taskDir, 'subtasks', 'perps-review-SIGNAL.json'),
      `${JSON.stringify({
        role: 'subtask',
        contextId: 'perps-review',
        parent: { checklist: 'CHECKLIST.md', stepNumber: 2 },
        status: options.childStatus ?? 'running',
        checklistTiming: {
          schemaVersion: 1,
          source: 'subtasks/perps-review.md',
          events: [{ stepNumber: 1, label: '1. read the diff', checkedAt }],
        },
        timestamp: checkedAt,
      })}\n`,
    );
  }
  return { root, taskFileRel: path.join(taskDirRel, 'CHECKLIST.md') };
}

async function progressFor(fixture: Fixture) {
  return taskProgress({ slotId: 'slot-projection', taskFile: fixture.taskFileRel });
}

test('explicit checklist reads carry parent mark timing and child registration boundaries', async (t) => {
  const fixture = writeFixture({ lastEventAt: '2026-09-19T09:02:00Z' });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const timing = {
    schemaVersion: 1,
    source: 'CHECKLIST.md',
    events: [{ stepNumber: 1, label: '1. read the ticket', checkedAt: '2026-09-19T09:01:00Z' }],
  };
  writeFileSync(
    path.join(fixture.root, path.dirname(fixture.taskFileRel), 'SIGNAL.json'),
    JSON.stringify({
      status: 'running',
      timestamp: '2026-09-19T09:01:00Z',
      checklistTiming: timing,
    }),
  );
  const result = await progressFor(fixture);
  assert.deepEqual(result.structured?.timing?.events, timing.events);
  const child = result.structured?.phases
    .flatMap((phase) => phase.steps)
    .find((step) => step.index === 2)?.subtask?.progress;
  assert.equal(child?.timing?.startedAt, '2026-09-19T09:00:00Z');
  assert.equal(child?.timing?.events[0].checkedAt, '2026-09-19T09:02:00Z');
});

function stepsOf(result: Awaited<ReturnType<typeof taskProgress>>) {
  return (result.structured?.phases ?? []).flatMap((phase) => phase.steps);
}

test('task.progress attaches the child projection to the step that owns it', async () => {
  const fixture = writeFixture({});
  try {
    const result = await progressFor(fixture);
    const steps = stepsOf(result);
    assert.equal(steps.length, 3);
    const owner = steps.find((step) => step.index === 2);
    assert.ok(owner?.subtask, 'step 2 carries the child unit');
    assert.equal(owner.subtask.id, 'perps-review');
    assert.equal(owner.subtask.status, 'running');
    assert.deepEqual(owner.subtask.source, {
      kind: 'skill',
      ref: 'skills/review.md',
      sha256: 'aa',
      renderedSha256: 'bb',
    });
    // Depth 1: the child's own steps come from its checklist, enumerated by the
    // same parser — the informational `## Rules` box is not a step.
    assert.equal(owner.subtask.progress.totalSteps, 2);
    assert.equal(owner.subtask.progress.completedSteps, 1);
    assert.equal(owner.subtask.progress.currentStep, '2. check the domain patterns');
    // Nothing else is touched.
    assert.equal(steps.find((step) => step.index === 1)?.subtask, undefined);
    assert.equal(steps.find((step) => step.index === 3)?.subtask, undefined);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('task.progress projects stale for a running child whose last mark aged out', async () => {
  const fixture = writeFixture({
    childStatus: 'running',
    lastEventAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
  });
  try {
    const steps = stepsOf(await progressFor(fixture));
    assert.equal(steps.find((step) => step.index === 2)?.subtask?.status, 'stale');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('task.progress keeps blocked and complete statuses from the child signal', async () => {
  for (const status of ['blocked', 'complete'] as const) {
    const fixture = writeFixture({
      childStatus: status,
      // Old enough to be stale if the projection ignored the file's own status.
      lastEventAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    });
    try {
      const steps = stepsOf(await progressFor(fixture));
      assert.equal(steps.find((step) => step.index === 2)?.subtask?.status, status);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test('task.progress ignores a child parented on a different checklist', async () => {
  const fixture = writeFixture({ parentChecklist: 'REVIEW.md' });
  try {
    const steps = stepsOf(await progressFor(fixture));
    assert.deepEqual(
      steps.map((step) => step.subtask),
      [undefined, undefined, undefined],
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('task.progress fails loudly on an invalid registry instead of reporting no children', async () => {
  const fixture = writeFixture({ indexBody: '{"schemaVersion":1,"units":[{"id":"BAD ID"}]}\n' });
  try {
    await assert.rejects(() => progressFor(fixture), /units\[0\]\.id must be a slug/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('task.progress still returns parent progress when a registered child has no checklist', async () => {
  const fixture = writeFixture({ omitChildFiles: true });
  try {
    const result = await progressFor(fixture);
    assert.equal(result.structured?.totalSteps, 3);
    assert.equal(stepsOf(result).find((step) => step.index === 2)?.subtask, undefined);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a reviewer's open unit reads as ended once that reviewer has completed or failed", async (t) => {
  const reviewChecklist = 'REVIEW.rev-1.md';
  const cases = [
    { owner: 'failed', child: 'running', ownerEnded: true },
    { owner: 'complete', child: 'blocked', ownerEnded: true },
    { owner: 'working', child: 'running', ownerEnded: undefined },
    { owner: 'blocked', child: 'running', ownerEnded: undefined },
    { owner: 'failed', child: 'complete', ownerEnded: undefined },
  ] as const;
  for (const { owner, child, ownerEnded } of cases) {
    const fixture = writeFixture({ parentChecklist: reviewChecklist, childStatus: child });
    t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
    const taskFile = path.join(path.dirname(fixture.taskFileRel), reviewChecklist);
    writeFileSync(path.join(fixture.root, taskFile), PARENT_MARKDOWN);
    slotRun = makeRun({
      id: 'run-owner',
      status: 'reviewing',
      slotId: 'slot-projection',
      flowType: 'dev',
      agentContexts: [
        {
          id: 'rev-1',
          role: 'review',
          label: 'Reviewer',
          status: owner,
          slotId: 'slot-projection',
          runId: 'run-owner',
          taskFile: path.join(fixture.root, taskFile),
          startedAt: '2026-09-19T09:00:00Z',
        },
      ],
    });
    t.after(() => {
      slotRun = undefined;
    });
    const steps = stepsOf(await taskProgress({ slotId: 'slot-projection', taskFile }));
    assert.equal(
      steps.find((step) => step.index === 2)?.subtask?.ownerEnded,
      ownerEnded,
      `owner ${owner}, child ${child}`,
    );
  }
});
