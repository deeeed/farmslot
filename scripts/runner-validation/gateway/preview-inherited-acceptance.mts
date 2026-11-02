#!/usr/bin/env tsx
// Live proof (F286) that a pr-complete dispatch preview names the acceptance criteria the run will
// be held to: its parent run's original ones, not any given with it. 9f0b6812, a CI-fix
// pr-complete, was held to family 8a768552's AC1-AC4 without the preview saying so.
//
// An isolated gateway (own pool, projects, runs and home) holds three finished runs that opened
// PRs: one with registered criteria, one whose ticket has none, one with no ticket at all.
// `dispatch.preview` over a real WebSocket, and `farmslot dispatch preview` against the same
// gateway, must name the first one's criteria (also from a bare PR number and beside a family
// id, as run.create links them), say why the second one's can't be read, and name nothing for
// the third (the writer holds that run to its own ticket). `gh` is a failing fixture, so nothing
// reaches GitHub. The CLI runs under `script` (macOS) for the terminal rendering an operator
// sees, and once without a terminal for its JSON envelope.
//
// Run: yarn tsx scripts/runner-validation/gateway/preview-inherited-acceptance.mts [evidence-dir]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  cleanupOnExit,
  type IsolatedStackParts,
  linkCheckout,
  startIsolatedStack,
  startReaper,
  stopProcess,
  writeJson as json,
} from '../lib/isolated-stack.mjs';
import type { DispatchPreviewResult } from '../../../packages/protocol/src/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const evidence = path.resolve(
  root,
  process.argv[2] ?? `temp/preview-inherited-acceptance/${Date.now()}`,
);
await mkdir(evidence, { recursive: true });
const fixture = await realpath(await mkdtemp(path.join(tmpdir(), 'preview-inherited-acs-')));
const project = 'inherited-acs';
const slotId = 'inherited-acs-slot';
const repo = path.join(fixture, 'slot');
const home = path.join(fixture, 'home');
const env: NodeJS.ProcessEnv = { ...process.env };
delete env.TMUX;
delete env.TMUX_PANE;
// A slot worker's gateway URL would take the CLI elsewhere; it targets the proof's profile.
delete env.GW_URL;
const parts: IsolatedStackParts = {};
const cleanupErrors: unknown[] = [];
const reaper = startReaper();
reaper.path(fixture);
const cleanup = cleanupOnExit(async () => {
  const attempt = (step: () => Promise<unknown>) =>
    step().catch((error: unknown) => cleanupErrors.push(error));
  parts.connection?.close();
  await attempt(() => stopProcess(parts.gateway));
  await attempt(() => rm(fixture, { recursive: true, force: true }));
  reaper.done();
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
    { cwd, encoding: 'utf8', stdio: 'pipe' },
  ).trim();
/**
 * A finished dev run that opened PR `prNumber`; `criteria` undefined leaves its ticket without
 * any, and `ticket: false` leaves it without a ticket.
 */
function parentRun(prNumber: number, criteria?: string[], ticket = true) {
  const id = randomUUID();
  const at = new Date(Date.now() - 3_600_000).toISOString();
  return {
    id,
    project,
    ticketOrPr: `APP-${prNumber}`,
    flowType: 'dev',
    status: 'done',
    prNumber,
    branch: `feat/app-${prNumber}`,
    taskFile: path.join(repo, 'tasks', id, 'TASK.md'),
    createdAt: at,
    updatedAt: at,
    decisions: [],
    steps: [],
    metrics: { nudgeCount: 0, disposition: 'completed', runner: 'scripted', model: null },
    ...(ticket
      ? {
          ticketData: {
            source: 'manual',
            title: `App change ${prNumber}`,
            description: '',
            affectedArea: '',
            ...(criteria ? { acceptanceCriteria: criteria } : {}),
            stepsToReproduce: [],
            screenshots: [],
            labels: [],
          },
        }
      : {}),
  };
}

let failure: unknown;
let result: Record<string, unknown> | undefined;
try {
  await linkCheckout(root, fixture, 'Isolated inherited-acceptance fixture');
  const origin = path.join(fixture, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', origin], { stdio: 'pipe' });
  await mkdir(repo);
  git(repo, 'init', '-q', '--initial-branch=main');
  await writeFile(path.join(repo, 'README.md'), 'Fixture slot\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'fixture');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  const withCriteria = parentRun(4242, [
    'Every direct dependency is on its latest stable version.',
    'The test suite passes.',
  ]);
  const withoutCriteria = parentRun(4243);
  const withoutTicket = parentRun(4244, undefined, false);
  for (const run of [withCriteria, withoutCriteria, withoutTicket]) {
    await mkdir(path.dirname(run.taskFile), { recursive: true });
    await writeFile(run.taskFile, `# ${run.ticketOrPr}\n`);
    await json(path.join(fixture, 'runs', `${run.id}.json`), run);
  }
  await json(path.join(fixture, 'projects', project, 'project.json'), {
    name: project,
    repo_url: origin,
    default_branch: 'main',
    paths: { runtime_dir: '.agent', artifact_dir: '.task' },
    // Resolves a bare PR number to acme/app#N, as run.create does.
    ci: { repo: 'acme/app' },
  });
  await json(path.join(fixture, 'pool', `${project}.json`), {
    machine: 'localhost',
    host: 'localhost',
    ssh_user: process.env.USER ?? 'operator',
    project,
    platform: 'cli',
    os: process.platform,
    slots: [{ id: slotId, enabled: true, repo, session: slotId, resources: {} }],
  });
  await json(path.join(fixture, '.farm-status.json'), {
    checked_at: new Date().toISOString(),
    slots: [
      {
        slot: slotId,
        machine: 'localhost',
        project,
        platform: 'cli',
        repo,
        session: slotId,
        lifecycle: 'ready',
        phase: null,
        agent: 'idle',
        enabled: true,
        health: { ssh: 'LOCAL', device: '-', devserver: '-', fixtures: '-' },
      },
    ],
  });
  // A preview reads ticket metadata best-effort; this keeps it off GitHub.
  const shimDir = path.join(fixture, 'shim');
  await mkdir(shimDir);
  await writeFile(
    path.join(shimDir, 'gh'),
    '#!/bin/sh\necho "gh is disabled in this fixture" >&2\nexit 1\n',
  );
  await chmod(path.join(shimDir, 'gh'), 0o755);
  const { connection: gw } = await startIsolatedStack(
    {
      root,
      evidence,
      env,
      fixture,
      reaper,
      gatewayEnv: { PATH: `${shimDir}:${process.env.PATH}` },
    },
    parts,
  );
  const preview = async (ticketOrPr: string, familyId?: string) =>
    (
      await gw.call<DispatchPreviewResult>('dispatch.preview', {
        project,
        flowType: 'pr-complete',
        ticketOrPr,
        ...(familyId ? { familyId } : {}),
      })
    ).preview;
  const named = await preview('acme/app#4242');
  await json(path.join(evidence, 'preview-4242.json'), named);
  const inherited = {
    fromRunId: withCriteria.id,
    criteria: [
      { id: 'AC-1', text: 'Every direct dependency is on its latest stable version.' },
      { id: 'AC-2', text: 'The test suite passes.' },
    ],
  };
  assert.deepEqual(named.inheritedAcceptance, inherited);
  // run.create links the same parent from a bare PR number, and infers it beside a family id.
  const bare = await preview('4242');
  await json(path.join(evidence, 'preview-bare-4242.json'), bare);
  assert.deepEqual(bare.inheritedAcceptance, inherited, 'a bare PR number names the parent');
  const besideFamily = await preview('acme/app#4242', 'operator-family');
  assert.deepEqual(besideFamily.inheritedAcceptance, inherited, 'a family id still names it');
  // A parent without a ticket: the writer holds the run to its own ticket, nothing is inherited.
  const noTicket = await preview('acme/app#4244');
  await json(path.join(evidence, 'preview-4244.json'), noTicket);
  assert.equal(noTicket.inheritedAcceptance, undefined, 'nothing is inherited from 4244');
  const unreadable = await preview('acme/app#4243');
  await json(path.join(evidence, 'preview-4243.json'), unreadable);
  assert.equal(unreadable.inheritedAcceptance?.fromRunId, withoutCriteria.id);
  assert.deepEqual(unreadable.inheritedAcceptance?.criteria, []);
  assert.match(
    unreadable.inheritedAcceptance?.unavailable ?? '',
    /parent ticketData\.acceptanceCriteria is unavailable/,
  );
  // The operator's view: the CLI against the same gateway (its `proof` profile is in the proof's
  // home), in a terminal; without one it prints the JSON envelope instead.
  const cliEnv = { ...env, FARMSLOT_HOME: home, NO_COLOR: '1' };
  const cliArgs = (ticket: string) => [
    path.join(root, 'packages/cli/bin/farmslot.mjs'),
    '--gateway',
    'proof',
    'dispatch',
    'preview',
    '--project',
    project,
    '--flow-type',
    'pr-complete',
    '--ticket',
    ticket,
  ];
  const cli = async (ticket: string) => {
    const transcript = path.join(fixture, `cli-${ticket.replace(/\W/g, '-')}.typescript`);
    execFileSync('script', ['-q', transcript, process.execPath, ...cliArgs(ticket)], {
      env: cliEnv,
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 90_000,
    });
    // eslint-disable-next-line no-control-regex
    return (await readFile(transcript, 'utf8')).replace(
      /\x1b\[[0-9;?]*[A-Za-z]|\^D|[\r\x04\x08]/g,
      '',
    );
  };
  const printed = await cli('4242');
  const printedUnreadable = await cli('acme/app#4243');
  await writeFile(path.join(evidence, 'cli-4242.txt'), printed);
  await writeFile(path.join(evidence, 'cli-4243.txt'), printedUnreadable);
  assert.match(
    printed,
    new RegExp(
      `Acceptance: 2 criteria inherited from run ${withCriteria.id.slice(0, 8)}; any given with this run are not used`,
    ),
  );
  assert.match(printed, /AC-1: Every direct dependency is on its latest stable version\./);
  assert.match(printed, /AC-2: The test suite passes\./);
  assert.match(
    printedUnreadable,
    new RegExp(`Acceptance: inherited from run ${withoutCriteria.id.slice(0, 8)}, unreadable: `),
  );
  const envelope = JSON.parse(
    execFileSync(process.execPath, cliArgs('acme/app#4243'), {
      env: cliEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 90_000,
    }),
  ) as { status: string; data: DispatchPreviewResult };
  await json(path.join(evidence, 'cli-4243.json'), envelope);
  assert.equal(envelope.status, 'ok');
  assert.deepEqual(envelope.data.preview.inheritedAcceptance, unreadable.inheritedAcceptance);
  result = {
    pass: true,
    evidence,
    inherited: named.inheritedAcceptance,
    unreadable: unreadable.inheritedAcceptance,
  };
  await json(path.join(evidence, 'result.json'), result);
} catch (error) {
  failure = error;
  await json(path.join(evidence, 'failure.json'), { error: String(error), fixture });
} finally {
  await cleanup();
  if (cleanupErrors.length > 0)
    failure = new AggregateError(
      [...(failure ? [failure] : []), ...cleanupErrors],
      'Cleanup failed',
    );
}
if (failure) throw failure;
console.log(JSON.stringify(result));
