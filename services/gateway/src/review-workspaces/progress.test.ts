// The review-workspace progress publisher: what reaches clients while a
// slot-free static review runs, and what it refuses to re-send. Its two reads
// are injected, so these assertions are about its own rules — the throttle,
// change detection and the child-driven tag — not about file layout, which
// subtask-parity.test.ts proves against a real workspace task directory.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Events, type TaskProgressResult } from '@farmslot/protocol';

import {
  createReviewWorkspaceProgressPublisher,
  WORKSPACE_PROGRESS_INTERVAL_MS,
} from './progress.js';

interface ChildFixture {
  status: string;
  completedSteps: number;
  lastEventAt: string;
}

function projection(options: { parentChecked?: boolean; child?: ChildFixture; verdict?: string }) {
  const markdown = [
    '# Review',
    '',
    `- [${options.parentChecked ? 'x' : ' '}] **1. run the domain review**`,
    '- [ ] **2. write the report**',
    '',
  ].join('\n');
  const result: TaskProgressResult = {
    slotId: '',
    role: 'review',
    contextId: 'review',
    markdown,
    structured: {
      schema: { flowType: 'review-pr', title: 'Review', phases: [], totalSteps: 2 },
      phases: [
        {
          name: 'Review',
          completedSteps: options.parentChecked ? 1 : 0,
          totalSteps: 2,
          steps: [
            {
              index: 1,
              name: 'run the domain review',
              status: options.parentChecked ? 'done' : 'running',
              ...(options.child
                ? {
                    subtask: {
                      id: 'perps-review',
                      status: options.child.status as 'running',
                      source: { kind: 'skill' as const, sha256: 'aa', renderedSha256: 'bb' },
                      progress: {
                        schema: {
                          flowType: 'review-pr',
                          title: 'Perps review',
                          phases: [],
                          totalSteps: 3,
                        },
                        phases: [],
                        completedSteps: options.child.completedSteps,
                        totalSteps: 3,
                        currentPhase: null,
                        currentStep: null,
                      },
                      lastEventAt: options.child.lastEventAt,
                    },
                  }
                : {}),
            },
            { index: 2, name: 'write the report', status: 'pending' },
          ],
        },
      ],
      completedSteps: options.parentChecked ? 1 : 0,
      totalSteps: 2,
      currentPhase: 'Review',
      currentStep: 'run the domain review',
    },
  };
  if (options.verdict) {
    result.acceptanceStatus = {
      schemaVersion: 1,
      criteria: [
        {
          id: 'AC-1',
          text: 'Every blocking finding is named.',
          verdict: options.verdict as 'proven',
          evidence: [],
          recipeNodes: [],
          updatedAt: '2026-09-20T09:05:00Z',
        },
      ],
    };
  }
  return result;
}

interface Emitted {
  event: string;
  payload: Record<string, unknown>;
}

function harness(options: { isCurrent?: () => boolean } = {}) {
  const emitted: Emitted[] = [];
  const state = { reads: 0, refreshes: 0, refreshError: null as Error | null };
  let clock = 0;
  const publisher = createReviewWorkspaceProgressPublisher(
    'run-workspace',
    (event, payload) => emitted.push({ event, payload: payload as Record<string, unknown> }),
    { ...options, now: () => clock },
    {
      readProgress: async () => {
        state.reads += 1;
        return nextProgress();
      },
      refreshView: async () => {
        state.refreshes += 1;
        if (state.refreshError) throw state.refreshError;
        return 0;
      },
    },
  );
  return {
    emitted,
    publisher,
    state,
    advance(ms = WORKSPACE_PROGRESS_INTERVAL_MS) {
      clock += ms;
    },
  };
}

let nextProgress: () => TaskProgressResult = () => {
  throw new Error('no progress fixture installed');
};

test('the first read publishes progress and refreshes the view', async () => {
  const h = harness();
  nextProgress = () =>
    projection({ child: { status: 'running', completedSteps: 1, lastEventAt: 'a' } });
  const published = await h.publisher.publish();

  assert.ok(published, 'the first read always publishes');
  assert.equal(h.state.refreshes, 1);
  assert.equal(h.emitted.length, 1);
  assert.equal(h.emitted[0].event, Events.TASK_PROGRESS_UPDATED);
  assert.deepEqual(
    { ...h.emitted[0].payload, progress: undefined },
    {
      slotId: '',
      runId: 'run-workspace',
      role: 'review',
      contextId: 'review',
      progress: undefined,
    },
    'a workspace run publishes under its run id with an empty slot id',
  );
  assert.equal(
    h.emitted[0].payload.parentChecklist,
    undefined,
    'the first read is not child-driven',
  );
});

test('an unchanged projection is not re-broadcast, and the throttle bounds the reads', async () => {
  const h = harness();
  nextProgress = () =>
    projection({ child: { status: 'running', completedSteps: 1, lastEventAt: 'a' } });
  await h.publisher.publish();
  assert.equal(h.state.reads, 1);

  // Inside the interval: no read at all.
  await h.publisher.publish();
  assert.equal(h.state.reads, 1);

  h.advance();
  assert.equal(await h.publisher.publish(), null, 'nothing moved, so nothing is published');
  assert.equal(h.state.reads, 2);
  assert.equal(h.emitted.length, 1);
  assert.equal(h.state.refreshes, 1, 'an unchanged read does not rewrite the view');
});

test('a child mark that ticks no parent box is published as child-driven', async () => {
  const h = harness();
  nextProgress = () =>
    projection({ child: { status: 'running', completedSteps: 1, lastEventAt: 'a' } });
  await h.publisher.publish();

  h.advance();
  nextProgress = () =>
    projection({ child: { status: 'running', completedSteps: 2, lastEventAt: 'b' } });
  await h.publisher.publish();
  assert.equal(h.emitted.length, 2);
  assert.equal(
    h.emitted[1].payload.parentChecklist,
    'CHECKLIST.md',
    'the acceptance rule needs the parent checklist to place a live child',
  );

  // A child completion that also ticks the parent box is a parent-level update.
  h.advance();
  nextProgress = () =>
    projection({
      parentChecked: true,
      child: { status: 'complete', completedSteps: 3, lastEventAt: 'c' },
    });
  await h.publisher.publish();
  assert.equal(h.emitted.length, 3);
  assert.equal(h.emitted[2].payload.parentChecklist, undefined);
});

test('a recorded verdict alone publishes, without the child tag', async () => {
  const h = harness();
  nextProgress = () => projection({});
  await h.publisher.publish();

  h.advance();
  nextProgress = () => projection({ verdict: 'proven' });
  const published = await h.publisher.publish();
  assert.ok(published?.acceptanceStatus, 'the ledger rides the same broadcast');
  assert.equal(h.emitted.length, 2);
  assert.equal(h.emitted[1].payload.parentChecklist, undefined);
});

test('a failed progress read publishes nothing and leaves the next read free to succeed', async () => {
  const h = harness();
  nextProgress = () => {
    throw new Error('child registry is corrupt');
  };
  assert.equal(await h.publisher.publish(), null);
  assert.equal(h.emitted.length, 0);
  assert.equal(h.state.refreshes, 0);

  h.advance();
  nextProgress = () => projection({});
  assert.ok(await h.publisher.publish());
  assert.equal(h.emitted.length, 1);
});

test('a failed view refresh still publishes the progress it read', async () => {
  const h = harness();
  nextProgress = () => projection({});
  h.state.refreshError = new Error('the execution node went away');
  assert.ok(await h.publisher.publish());
  assert.equal(h.emitted.length, 1);
});

test('a superseded generation reads nothing and publishes nothing', async () => {
  const h = harness({ isCurrent: () => false });
  nextProgress = () => projection({});
  assert.equal(await h.publisher.publish(), null);
  assert.equal(h.state.reads, 0);
  assert.equal(h.emitted.length, 0);
});
