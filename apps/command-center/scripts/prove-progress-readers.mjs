import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { automationGatewayTarget } from '../../../scripts/lib/gateway-profile.mjs';

import { withOwnedGatewayOffline } from './owned-gateway-outage.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const cdpPath = fileURLToPath(new URL('./cdp.mjs', import.meta.url));
const probe = fileURLToPath(new URL('./probes/offline-progress-readers.js', import.meta.url));
const loopback = (hostname) => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
assert.equal(process.env.FARMSLOT_OFFLINE_PROOF, '1', 'Select the isolated proof stack');
assert.equal(process.env.FARMSLOT_DISABLE_ORCHESTRATION, '1');
assert(/^\d+$/.test(process.env.FARMSLOT_CDP_PORT ?? ''), 'Select the owned browser');
assert(process.env.FARMSLOT_HOME && process.env.FARMSLOT_SLOT_RESOURCE_PROOF);
assert(process.env.FARMSLOT_ROOT && process.env.FARMSLOT_RUNS_DIR);
assert(
  process.env.FARMSLOT_RUN_WEB_EVIDENCE_DIR &&
    path.isAbsolute(process.env.FARMSLOT_RUN_WEB_EVIDENCE_DIR),
  'Select an absolute proof artifact directory',
);
assert.equal(await realpath(process.cwd()), await realpath(root));
const artifacts = path.resolve(process.env.FARMSLOT_RUN_WEB_EVIDENCE_DIR);
const profile = await automationGatewayTarget();
assert(profile, 'Select an authenticated automation profile');
const gateway = new URL(profile.url);
assert(loopback(gateway.hostname), 'Use the owned loopback gateway');
assert.equal(Number(gateway.port), Number(process.env.GATEWAY_PORT));
const ui = new URL(process.env.FARMSLOT_UI_URL);
assert(loopback(ui.hostname), 'Use the owned loopback UI');
assert.equal(Number(ui.port), Number(process.env.VITE_PORT));
const fixture = JSON.parse(await readFile(process.env.FARMSLOT_SLOT_RESOURCE_PROOF));
const home = await realpath(process.env.FARMSLOT_HOME);
assert.equal(await realpath(fixture.home), home);
assert.equal(await realpath(fixture.root), await realpath(process.env.FARMSLOT_ROOT));
const repo = await realpath(fixture.repo);
assert(repo.startsWith(`${home}/`), 'The worker repository must belong to the isolated home');
assert.match(fixture.slotId, /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
const poolFile = await realpath(fixture.poolFile);
assert(poolFile.startsWith(`${home}/`), 'Use the isolated pool manifest');
const pool = JSON.parse(await readFile(poolFile));
assert(loopback(pool.host), 'Use the local owned scratch slot');
const configuredSlot = pool.slots.find(({ id }) => id === fixture.slotId);
assert(configuredSlot, 'The selected pool must declare the owned slot');
assert.equal(await realpath(configuredSlot.repo), repo);
assert.equal(configuredSlot.session, fixture.slotId);
const statusFile = path.join(fixture.root, '.farm-status.json');
const original = await readFile(statusFile);
const originalMode = (await stat(statusFile)).mode & 0o777;
const raw = JSON.parse(original);
const slot = raw.slots.find((row) => row.slot === fixture.slotId);
assert(slot && !slot.current_run_id && !slot.task_file, 'Require the unoccupied owned fixture');
const runId = randomUUID();
const taskRel = `dev/progress-readers-${runId}`;
const taskDir = path.join(repo, '.task', taskRel);
const checklist = path.join(taskDir, 'CHECKLIST.md');
const runs = await realpath(process.env.FARMSLOT_RUNS_DIR);
assert.equal(runs, path.join(home, 'runs'));
const runFile = path.join(runs, `${runId}.json`);
const markdown = (count) =>
  '# Owned progress readers\n\n' +
  [1, 2]
    .map((step) => `- [${step <= count ? 'x' : ' '}] **${step}. owned web step ${step}**\n`)
    .join('');
const cdp = async (...args) =>
  JSON.parse(
    (
      await execute(process.execPath, [cdpPath, ...args], {
        timeout: 30000,
        maxBuffer: 2 * 1024 * 1024,
      })
    ).stdout,
  );
const revision = (value) =>
  value.resourceState?.dependencies.find(({ key }) => key.family === 'progress')?.revision ?? -1;
let socketPath;
const tmux = async (...args) =>
  (
    await execute('tmux', ['-N', ...(socketPath ? ['-S', socketPath] : []), ...args], {
      timeout: 5000,
    })
  ).stdout.trim();
let seeded = false;
let ownsSession = false;
let tmuxIdentity;
const receipts = [];
const started = Date.now();
let expected = 0;
let result;
const errors = [];

async function navigate(surface) {
  const base = new URL(ui);
  base.searchParams.set('progress-reader-slot', fixture.slotId);
  base.searchParams.set('progress-reader-surface', surface);
  base.searchParams.set('progress-reader-case', runId);
  // The slot route mounts its real terminal alongside the task panel.
  const route = surface === 'fleet' ? 'fleet' : `slot/${fixture.slotId}`;
  base.hash = surface === 'fleet' ? route : `${route}?runId=${runId}&contextId=dev`;
  await cdp('goto', base.href);
  await cdp('focus', route);
  return route;
}

async function until(route, predicate, label) {
  const deadline = Date.now() + 25000;
  let value;
  do {
    value = await cdp('eval', route, '--file', probe);
    if (predicate(value)) return value;
    await delay(100);
  } while (Date.now() < deadline);
  assert.fail(`${label}: ${JSON.stringify(value)}`);
}

try {
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  await mkdir(taskDir, { recursive: true });
  await writeFile(path.join(taskDir, 'TASK.md'), '# Owned web progress task\n', { flag: 'wx' });
  await writeFile(checklist, markdown(0), { flag: 'wx' });
  socketPath = await tmux('display-message', '-p', '#{socket_path}');
  tmuxIdentity = await tmux('display-message', '-p', '#{socket_path} #{pid}');
  const sessions = (await tmux('list-sessions', '-F', '#{session_name}')).split('\n');
  assert(sessions.length > 1, 'The scratch session must never own the last server session');
  assert(!sessions.includes(fixture.slotId), 'Never replace an existing tmux session');
  await writeFile(
    path.join(artifacts, 'owner.json'),
    JSON.stringify(
      {
        runId,
        runFile,
        taskDir,
        statusFile,
        originalStatusBase64: original.toString('base64'),
        originalMode,
        session: fixture.slotId,
        tmuxIdentity,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  // This idle process is a terminal target, not a proof synchronization wait.
  // -N prevents starting a tmux server if the selected server disappears.
  await tmux('new-session', '-d', '-s', fixture.slotId, '-n', 'dev', '-c', repo, 'sleep 600');
  ownsSession = true;
  assert.equal(await tmux('display-message', '-p', '#{socket_path} #{pid}'), tmuxIdentity);
  const target = {
    session: fixture.slotId,
    window: 'dev',
    pane: '0',
    target: `${fixture.slotId}:dev.0`,
  };
  const now = new Date().toISOString();
  const run = {
    id: runId,
    familyId: runId,
    parentRunId: null,
    familyRootTicketOrPr: 'Owned web progress proof',
    lane: 'validation',
    variant: null,
    flowType: 'dev',
    mode: 'interactive',
    status: 'monitoring',
    project: fixture.project,
    ticketOrPr: 'Owned web progress proof',
    slotId: fixture.slotId,
    branch: null,
    completionPolicy: 'artifact-only',
    taskFile: path.join(taskDir, 'TASK.md'),
    activeTaskFile: path.join(taskDir, 'TASK.md'),
    steps: [{ name: 'monitor', status: 'running', startedAt: now }],
    decisions: [],
    metrics: {
      nudgeCount: 0,
      model: null,
      runner: null,
      runnerSessionId: null,
      runnerSessionPath: null,
    },
    createdAt: now,
    startedAt: now,
    updatedAt: now,
    agentContexts: [
      {
        id: 'dev',
        role: 'dev',
        label: 'Owned developer',
        status: 'working',
        runId,
        slotId: fixture.slotId,
        taskFile: path.join(taskDir, 'TASK.md'),
        target,
        updatedAt: now,
      },
    ],
  };
  Object.assign(slot, {
    lifecycle: 'busy',
    phase: 'working',
    current_run_id: runId,
    task_file: taskRel,
    current_flow_type: 'dev',
    current_ticket_or_pr: run.ticketOrPr,
  });
  await withOwnedGatewayOffline(async () => {
    await writeFile(runFile, JSON.stringify(run), { flag: 'wx', mode: 0o600 });
    seeded = true;
    await writeFile(statusFile, JSON.stringify(raw));
  });
  for (const surface of ['fleet', 'slot', 'terminal']) {
    const route = await navigate(surface);
    const initial = await until(
      route,
      (value) =>
        value.canonical &&
        value.rendered &&
        value.freshness === 'ready' &&
        value.runId === runId &&
        value.completed === expected,
      `Mount actual ${surface} progress from shared cache`,
    );
    expected = expected === 0 ? 1 : 0;
    await writeFile(checklist, markdown(expected));
    const changed = await until(
      route,
      (value) =>
        value.canonical &&
        value.rendered &&
        value.freshness === 'ready' &&
        value.runId === runId &&
        value.completed === expected &&
        revision(value) > revision(initial),
      `A real owned checklist write updates ${surface}`,
    );
    const idle = await cdp('idle-reads', route, '11000', '["task.progress"]');
    assert.equal(idle.total, 0, `No periodic progress reads on ${surface}`);
    const settled = await cdp('eval', route, '--file', probe);
    assert.equal(settled.connectionId, changed.connectionId, 'Idle proof cannot hide a reconnect');
    assert.equal(settled.freshness, 'ready');
    assert.equal(settled.completed, expected);
    assert(settled.canonical && settled.rendered, 'The idle measurement must keep its real reader');
    await cdp('screenshot', route, path.join(artifacts, `${surface}-progress.png`));
    const receipt = { surface, initial, changed, idle, settled };
    receipts.push(receipt);
    await writeFile(path.join(artifacts, `${surface}.json`), JSON.stringify(receipt, null, 2));
  }
  result = {
    fleetFileUpdate: true,
    slotFileUpdate: true,
    terminalFileUpdate: true,
    fleetProgressIdle: true,
    slotProgressIdle: true,
    terminalProgressIdle: true,
    elapsedMs: Date.now() - started,
    receipts: receipts.length,
  };
} catch (error) {
  errors.push(error);
}
{
  try {
    if (seeded)
      await withOwnedGatewayOffline(async () => {
        assert.equal(JSON.parse(await readFile(runFile)).id, runId);
        const current = JSON.parse(await readFile(statusFile));
        assert.equal(
          current.slots.find((row) => row.slot === fixture.slotId)?.current_run_id,
          runId,
          'Preserve a slot rebound by another actor',
        );
        await writeFile(statusFile, original);
        await chmod(statusFile, originalMode);
        await rm(runFile);
        await rm(taskDir, { recursive: true });
        assert.deepEqual(await readFile(statusFile), original);
        assert.equal((await stat(statusFile)).mode & 0o777, originalMode);
      });
    else await rm(taskDir, { recursive: true, force: true });
  } catch (error) {
    errors.push(error);
  }
  try {
    if (ownsSession) {
      assert.equal(await tmux('display-message', '-p', '#{socket_path} #{pid}'), tmuxIdentity);
      const sessions = (await tmux('list-sessions', '-F', '#{session_name}')).split('\n');
      if (sessions.includes(fixture.slotId)) {
        assert(sessions.length > 1, 'Never terminate the last tmux session');
        assert(
          (await tmux('list-panes', '-s', '-t', fixture.slotId, '-F', '#{pane_current_path}'))
            .split('\n')
            .every((value) => value === repo),
          'Preserve a scratch session whose ownership changed',
        );
        await tmux('kill-session', '-t', fixture.slotId);
      }
    }
  } catch (error) {
    errors.push(error);
  }
}
if (errors.length) throw new AggregateError(errors, 'Progress-reader proof or cleanup failed');
await writeFile(path.join(artifacts, 'summary.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
