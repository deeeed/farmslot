import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { invalidateProjectVarsCache } from '@farmslot/slot-config';

import '../../runtime/mock-pty.test-support.js';

import { jiraTicketData, manualTicketData } from '../../run-completion/test-fixtures.js';

const temporary = await mkdtemp(path.join(os.tmpdir(), 'jira-ticket-admission-'));
process.env.FARMSLOT_RUNS_DIR = path.join(temporary, 'runs');

const { farmslotRoot } = await import('../../fleet/state.js');
const { createRun, deleteRun, getAllRuns, getRun, updateRun } = await import('../../runs/store.js');
const { fetchTicketData } = await import('../../run-engine/ticket-data.js');
const { backfillMissingRunLinks } = await import('../../run-engine/run-links.js');
const { runCreate } = await import('../run.js');
const { jiraTicketDataForCreate } = await import('./ticket-policy.js');

// A project with a Jira source whose credentials live in test-only env names.
const project = `.jira-admission-test-${process.pid}`;
const projectDir = path.join(farmslotRoot, 'projects', project);
await mkdir(projectDir, { recursive: true });
await writeFile(
  path.join(projectDir, 'project.json'),
  JSON.stringify({
    name: project,
    default_branch: 'main',
    jira: {
      base_url: 'https://jira.example.invalid',
      email_env: 'FARMSLOT_TEST_JIRA_EMAIL',
      api_token_env: 'FARMSLOT_TEST_JIRA_TOKEN',
    },
  }),
);
invalidateProjectVarsCache(project);
test.after(async () => {
  await rm(projectDir, { recursive: true, force: true });
  invalidateProjectVarsCache(project);
  await rm(temporary, { recursive: true, force: true });
});

const ISSUE = {
  key: 'TAT-4138',
  fields: {
    summary: 'Implement market icon mapping',
    description: {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Serve base icons.' }] }],
    },
    status: { name: 'To Do' },
    issuetype: { name: 'Task' },
    labels: [],
    components: [],
  },
};

function withJira(t: test.TestContext, respond: (url: string) => Response | Promise<Response>) {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    return respond(url);
  };
  process.env.FARMSLOT_TEST_JIRA_EMAIL = 'ops@example.invalid';
  process.env.FARMSLOT_TEST_JIRA_TOKEN = 'test-token';
  t.after(() => {
    globalThis.fetch = originalFetch;
    delete process.env.FARMSLOT_TEST_JIRA_EMAIL;
    delete process.env.FARMSLOT_TEST_JIRA_TOKEN;
  });
  return requested;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('creating a run for a Jira key on a project without a Jira source refuses (TAT-4138 / fca56a36)', async () => {
  const before = getAllRuns().length;
  await assert.rejects(
    runCreate(
      { project: 'farmslot-farm', flowType: 'dev', mode: 'autonomous', ticketOrPr: 'TAT-4138' },
      () => {},
    ),
    /^Error: TAT-4138 is a Jira key, but project farmslot-farm has no Jira source\./,
  );
  // A caller-supplied key-only ticket is not a Jira read either.
  await assert.rejects(
    runCreate(
      {
        project: 'farmslot-farm',
        flowType: 'fix-bug',
        ticketOrPr: 'TAT-4138',
        ticketData: manualTicketData('TAT-4138'),
      },
      () => {},
    ),
    /no Jira source/,
  );
  assert.equal(getAllRuns().length, before);
});

test('a configured Jira source without credentials refuses and names the missing env vars', async () => {
  await assert.rejects(
    fetchTicketData({ project, ticketOrPr: 'TAT-4138' }),
    new RegExp(
      `^Error: Cannot read Jira ticket TAT-4138 for project ${project.replace(/\./g, '\\.')}: ` +
        'the gateway has no FARMSLOT_TEST_JIRA_EMAIL or FARMSLOT_TEST_JIRA_TOKEN\\.$',
    ),
  );
});

test('a Jira API failure refuses instead of falling back to the key', async (t) => {
  withJira(t, () => json({ errorMessages: ['Issue does not exist'] }, 404));
  await assert.rejects(
    fetchTicketData({ project, ticketOrPr: 'TAT-4138' }),
    /^Error: Cannot read Jira ticket TAT-4138 for project .*: Jira API error: 404/,
  );
});

test('creation stores the Jira ticket read through the project source', async (t) => {
  const requested = withJira(t, (url) =>
    url.includes('/comment') ? json({ comments: [] }) : json(ISSUE),
  );
  const ticket = await jiraTicketDataForCreate({
    project,
    flowType: 'dev',
    ticketOrPr: 'TAT-4138',
  });
  assert.equal(ticket?.source, 'jira');
  assert.equal(ticket?.jiraKey, 'TAT-4138');
  assert.equal(ticket?.title, 'Implement market icon mapping');
  assert.match(ticket?.description ?? '', /Serve base icons\./);
  assert.ok(requested[0]?.startsWith('https://jira.example.invalid/rest/api/3/issue/TAT-4138?'));
});

test('creation keeps a caller ticket read from Jira for the same key and leaves other runs alone', async (t) => {
  const requested = withJira(t, () => json({}, 500));
  const copied = jiraTicketData('TAT-4138', 'Implement market icon mapping');
  const base = { project, flowType: 'dev' as const, ticketOrPr: 'TAT-4138' };
  assert.equal(await jiraTicketDataForCreate({ ...base, ticketData: copied }), copied);
  for (const params of [
    { ...base, flowType: 'qa' as const },
    { ...base, ticketOrPr: 'MANUAL-000146' },
    { ...base, ticketOrPr: 'example-org/example-repo#12' },
    { ...base, flowType: 'pr-complete' as const, ticketOrPr: 'example-org/example-repo#12' },
    // The caller wrote the task, or the run is a validation or comparison run.
    { ...base, taskFile: '/tasks/dev/TAT-4138/TASK.md' },
    { ...base, mode: 'validation' as const },
    { ...base, lane: 'comparison' as const, variant: 'replay' },
  ]) {
    assert.equal(await jiraTicketDataForCreate(params), undefined, JSON.stringify(params));
  }
  assert.deepEqual(requested, []);
});

test('overlapping creates for one Jira key store one run', async (t) => {
  const previous = {
    NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT,
    FARMSLOT_DISABLE_RUN_ENGINE_START: process.env.FARMSLOT_DISABLE_RUN_ENGINE_START,
  };
  process.env.NODE_TEST_CONTEXT = '1';
  process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const requested = withJira(t, async (url) => {
    await held;
    return url.includes('/comment') ? json({ comments: [] }) : json(ISSUE);
  });
  const created: string[] = [];
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const id of created) {
      updateRun(id, { status: 'done', completedAt: new Date().toISOString() });
      await deleteRun(id);
    }
  });
  const params = { project, flowType: 'dev', mode: 'autonomous', ticketOrPr: 'TAT-4138' } as const;
  const attempts = [runCreate({ ...params }, () => {}), runCreate({ ...params }, () => {})];
  // Both requests pass planning and wait on the Jira read before either is stored.
  for (let i = 0; i < 200 && requested.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(requested.length, 2);
  release();
  const settled = await Promise.allSettled(attempts);
  for (const result of settled)
    if (result.status === 'fulfilled') created.push(result.value.run.id);
  assert.equal(created.length, 1);
  const refused = settled.find((result) => result.status === 'rejected');
  assert.match(String(refused?.reason), /Active run already exists for TAT-4138/);
  assert.equal(getAllRuns().filter((run) => run.ticketOrPr === 'TAT-4138').length, 1);
  // A ticket read at creation still gets its Jira link.
  assert.ok(
    getRun(created[0])?.links?.some(
      (link) =>
        link.label === 'Jira' && link.url === 'https://jira.example.invalid/browse/TAT-4138',
    ),
  );
});

test('a caller-supplied Jira ticket gets its Jira link at creation (TAT-4006 / 7721a02b)', async (t) => {
  const previous = {
    NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT,
    FARMSLOT_DISABLE_RUN_ENGINE_START: process.env.FARMSLOT_DISABLE_RUN_ENGINE_START,
  };
  process.env.NODE_TEST_CONTEXT = '1';
  process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';
  const requested = withJira(t, () => json({}, 500));
  let runId = '';
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (!runId) return;
    updateRun(runId, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(runId);
  });
  const result = await runCreate(
    {
      project,
      flowType: 'dev',
      mode: 'autonomous',
      ticketOrPr: 'TAT-4006',
      ticketData: jiraTicketData('TAT-4006', 'Add environment_type to perps events'),
    },
    () => {},
  );
  runId = result.run.id;
  assert.deepEqual(requested, []);
  assert.deepEqual(getRun(runId)?.links, [
    { label: 'Jira', url: 'https://jira.example.invalid/browse/TAT-4006' },
  ]);
});

test('a stored run without links gets its Jira link at startup (4237202e)', async (t) => {
  const unlinked = createRun({
    project,
    flowType: 'dev',
    ticketOrPr: 'TAT-4158',
    ticketData: jiraTicketData('TAT-4158', 'Order book depth'),
  });
  const linked = createRun({ project, flowType: 'dev', ticketOrPr: 'TAT-4159' });
  updateRun(linked.id, { links: [{ label: 'PR', url: 'https://github.com/o/r/pull/9' }] });
  t.after(async () => {
    for (const run of [unlinked, linked]) {
      updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });
  assert.equal(getRun(unlinked.id)?.links, undefined);
  await backfillMissingRunLinks([getRun(unlinked.id)!, getRun(linked.id)!]);
  assert.deepEqual(getRun(unlinked.id)?.links, [
    { label: 'Jira', url: 'https://jira.example.invalid/browse/TAT-4158' },
  ]);
  // A run that already has links keeps them.
  assert.deepEqual(getRun(linked.id)?.links, [
    { label: 'PR', url: 'https://github.com/o/r/pull/9' },
  ]);
});

test('a stored run of a project without config is skipped, reported once', async (t) => {
  const missing = `.jira-admission-missing-${process.pid}`;
  const runs = [1, 2].map((n) =>
    createRun({
      project: missing,
      flowType: 'dev',
      ticketOrPr: `TAT-${4300 + n}`,
      ticketData: jiraTicketData(`TAT-${4300 + n}`, 'Gone project'),
    }),
  );
  const warn = t.mock.method(console, 'warn', () => {});
  t.after(async () => {
    for (const run of runs) {
      updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });
  await backfillMissingRunLinks(runs.map((run) => getRun(run.id)!));
  for (const run of runs) assert.equal(getRun(run.id)?.links, undefined);
  assert.equal(
    warn.mock.calls.filter((call) => String(call.arguments[0]).includes('run links skipped'))
      .length,
    1,
  );
});
