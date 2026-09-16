import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import {
  type ProjectQaConfig,
  type QueueItem,
  resolveReviewQaDispatch,
  ReviewQaConfigurationError,
} from '@farmslot/protocol';

const root = mkdtempSync(path.join(tmpdir(), 'qa-run-admission-'));
const previous = {
  FARMSLOT_PROJECTS_DIR: process.env.FARMSLOT_PROJECTS_DIR,
  FARMSLOT_RUNS_DIR: process.env.FARMSLOT_RUNS_DIR,
  FARMSLOT_DISABLE_RUN_ENGINE_START: process.env.FARMSLOT_DISABLE_RUN_ENGINE_START,
};
process.env.FARMSLOT_PROJECTS_DIR = path.join(root, 'projects');
process.env.FARMSLOT_RUNS_DIR = path.join(root, 'runs');
process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';
mkdirSync(process.env.FARMSLOT_PROJECTS_DIR, { recursive: true });
after(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});
const { runCreate, queuedQaExpectation, assertExpectedQaSelection } = await import('../run.js');
const { invalidateProjectVarsCache } = await import('../../core/config.js');
const { getAllRuns, getRun, updateRun, deleteRun } = await import('../../runs/store.js');
const { migrateQueuedReviewQa } = await import('../../backlog/review-qa-migration.js');
const qa: ProjectQaConfig = {
  default_profile: 'pr',
  profiles: [
    { id: 'pr', title: 'PR validation', template_id: 'validation/shared', inputs: { scope: 'pr' } },
  ],
};
let sequence = 0;
function fixture() {
  const project = `qa-boundary-${++sequence}`;
  const directory = path.join(root, 'projects', project);
  mkdirSync(directory, { recursive: true });
  const config = {
    name: project,
    ci: { repo: 'example/app' },
    execution_templates: { sources: [] },
    qa: structuredClone(qa),
    workflow_defaults: {
      qa: {
        review: {
          sessionIntent: 'resume' as const,
          scope: 'full' as const,
          workflow: 'qa' as const,
          qaInputs: {} as Record<string, string>,
        },
      },
    },
  };
  const save = () => {
    writeFileSync(path.join(directory, 'project.json'), JSON.stringify(config));
    invalidateProjectVarsCache(project);
  };
  save();
  const item: QueueItem = {
    id: `queued-${project}`,
    project,
    flowType: 'review-pr',
    ticketOrPr: 'example/app#42',
    priority: 10,
    status: 'queued',
    createdAt: new Date().toISOString(),
    reviewValidationDepth: 'full-live',
  };
  migrateQueuedReviewQa(item, config.qa, config.workflow_defaults);
  const expected = queuedQaExpectation(item)!;
  const params = {
    flowType: 'qa' as const,
    project,
    ticketOrPr: item.ticketOrPr,
    mode: 'autonomous' as const,
    qaProfileId: item.qaProfileId,
    qaInputs: item.qaInputs,
    executionTemplateId: item.executionTemplateId,
  };
  return { config, save, item, expected, params };
}
async function cleanup(id: string) {
  if (getRun(id)) {
    updateRun(id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(id);
  }
}

test('late farm QA input additions are rejected at the final create boundary without a Run or queue stamp', async () => {
  const f = fixture();
  f.config.workflow_defaults.qa.review.qaInputs.addedAfterQueueCheck = 'unrequested';
  f.save();
  const before = getAllRuns().length;
  let reachedBoundary = false,
    stamped = false;
  await assert.rejects(
    runCreate(f.params, () => {}, {
      expectedQa: f.expected,
      beforeCreate: () => {
        reachedBoundary = true;
      },
      afterCreateSync: () => {
        stamped = true;
      },
      awaitPersist: true,
    }),
    (error) =>
      error instanceof ReviewQaConfigurationError && /changed while queued/.test(error.message),
  );
  assert.equal(reachedBoundary, true);
  assert.equal(stamped, false);
  assert.equal(getAllRuns().length, before);
  assert.deepEqual(f.item.qaInputs, { scope: 'pr' });
});

test('a matching queued selection creates only its frozen QA inputs', async (t) => {
  const f = fixture();
  const result = await runCreate(f.params, () => {}, {
    expectedQa: f.expected,
    awaitPersist: true,
  });
  t.after(() => cleanup(result.run.id));
  assert.equal(result.run.flowType, 'qa');
  assert.equal(result.run.qa?.profile.id, 'pr');
  assert.equal(result.run.qa?.profile.template_id, 'validation/shared');
  assert.deepEqual(result.run.qa?.inputs, f.expected.inputs);
});

test('public direct QA can still resolve current defaults without a queued expectation', async (t) => {
  const f = fixture();
  f.config.workflow_defaults.qa.review.qaInputs.directDefault = 'current';
  f.save();
  const result = await runCreate(f.params, () => {}, { awaitPersist: true });
  t.after(() => cleanup(result.run.id));
  assert.deepEqual(result.run.qa?.inputs, { directDefault: 'current', scope: 'pr' });
});

test('the trusted expectation is detached before asynchronous creation work', async () => {
  const f = fixture();
  f.config.workflow_defaults.qa.review.qaInputs.addedAfterQueueCheck = 'unrequested';
  f.save();
  await assert.rejects(
    runCreate(f.params, () => {}, {
      expectedQa: f.expected,
      beforeCreateAsync: async () => {
        f.expected.inputs.addedAfterQueueCheck = 'unrequested';
      },
      awaitPersist: true,
    }),
    /changed while queued/,
  );
});

test('profile id, template id and effective inputs are all part of the queued expectation', () => {
  const f = fixture();
  const selected = resolveReviewQaDispatch(f.params, qa)!;
  assertExpectedQaSelection(selected, f.expected);
  for (const expected of [
    { ...f.expected, profileId: 'other' },
    { ...f.expected, templateId: 'validation/other' },
    { ...f.expected, inputs: { scope: 'release' } },
  ])
    assert.throws(() => assertExpectedQaSelection(selected, expected), /changed while queued/);
  assert.throws(() => assertExpectedQaSelection(undefined, f.expected), /changed while queued/);
  assert.throws(() => queuedQaExpectation({ flowType: 'qa' }), /lacks its admitted/);
  assert.equal(queuedQaExpectation({ flowType: 'dev' }), undefined);
  f.item.qaInputs!.scope = 'changed';
  assert.deepEqual(f.expected.inputs, { scope: 'pr' });
});

test('RPC parameters cannot supply a trusted queued expectation', async () => {
  const f = fixture();
  const forged = { ...f.params, expectedQa: f.expected };
  await assert.rejects(
    runCreate(forged, () => {}),
    /cannot be supplied in run parameters/,
  );
});
