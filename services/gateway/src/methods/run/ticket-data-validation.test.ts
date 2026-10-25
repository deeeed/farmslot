import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import '../../runtime/mock-pty.test-support.js';

const home = await mkdtemp(path.join(os.tmpdir(), 'ticket-data-validation-'));
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_HOME: home,
  FARMSLOT_RUNS_DIR: path.join(home, 'runs'),
  FARMSLOT_PROJECTS_DIR: path.join(home, 'projects'),
  FARMSLOT_POOL_DIR: path.join(home, 'pool'),
  FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
});
const project = 'ticket-validation';
await mkdir(path.join(home, 'projects', project), { recursive: true });
await mkdir(path.join(home, 'pool'));
await writeFile(
  path.join(home, 'projects', project, 'project.json'),
  JSON.stringify({ name: project, default_branch: 'main', hooks: {} }),
);
const { Methods } = await import('@farmslot/protocol');
const { jiraTicketData } = await import('../../run-completion/test-fixtures.js');
const { routeRunMethod } = await import('../../server/run-route.js');
const { deleteRun, getAllRuns, updateRun } = await import('../../runs/store.js');
const ticket = () => jiraTicketData('TAT-4436', 'Preserve the supplied ticket');
const request = (ticketData: unknown) => ({
  project,
  flowType: 'fix-bug',
  mode: 'autonomous',
  transport: 'tmux',
  ticketOrPr: 'TAT-4436',
  ticketData,
});
const context = { emit: () => {}, broadcast: () => {} };
test.afterEach(async () => {
  for (const run of getAllRuns()) {
    updateRun(run.id, { status: 'done' });
    await deleteRun(run.id);
  }
});
test.after(async () => rm(home, { recursive: true, force: true }));

test('run.create refuses missing ticketData.description before registering or emitting a run', async () => {
  const { description: _description, ...withoutDescription } = ticket();
  const events: unknown[] = [];
  await assert.rejects(
    routeRunMethod(Methods.RUN_CREATE, request(withoutDescription), {
      emit: (_event, payload) => events.push(payload),
      broadcast: (frame) => events.push(frame),
    }),
    /Missing required field: ticketData\.description/,
  );
  assert.deepEqual(getAllRuns(), []);
  assert.deepEqual(events, []);
});

test('native run creation uses the same named ticketData validation', async () => {
  const { description: _description, ...withoutDescription } = ticket();
  await assert.rejects(
    routeRunMethod(
      Methods.RUN_CREATE_NATIVE,
      { ...request(withoutDescription), transport: 'native' },
      context,
    ),
    /Missing required field: ticketData\.description/,
  );
  assert.deepEqual(getAllRuns(), []);
});

test('run.create identifies malformed required ticket fields', async () => {
  const cases: Array<[string, unknown]> = [
    ['description', null],
    ['title', 7],
    ['affectedArea', []],
    ['acceptanceCriteria', undefined],
    ['stepsToReproduce', 'one step'],
    ['screenshots', null],
    ['labels', [3]],
    ['source', 'unknown-tracker'],
  ];
  for (const [field, value] of cases) {
    await assert.rejects(
      routeRunMethod(Methods.RUN_CREATE, request({ ...ticket(), [field]: value }), context),
      new RegExp('(?:Missing required|Invalid) field: ticketData\\.' + field),
    );
    assert.deepEqual(getAllRuns(), []);
  }
});

test('run.create refuses a non-object ticketData by name', async () => {
  for (const value of [null, [], 'ticket']) {
    await assert.rejects(
      routeRunMethod(Methods.RUN_CREATE, request(value), context),
      /Invalid field: ticketData .*object/,
    );
  }
});

test('valid empty description and arrays survive creation unchanged', async () => {
  const supplied = ticket();
  await routeRunMethod(Methods.RUN_CREATE, request(supplied), context);
  assert.equal(getAllRuns().length, 1);
  assert.deepEqual(getAllRuns()[0].ticketData, supplied);
  assert.equal(getAllRuns()[0].status, 'created');
});
