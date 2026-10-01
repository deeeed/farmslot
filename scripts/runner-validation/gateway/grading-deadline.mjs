import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FLOW_STEPS } from '@farmslot/protocol';

const sourceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'farmslot-grading-deadline-'));
const root = path.join(temporaryRoot, 'root');
const runId = randomUUID();
const project = 'grading-proof';
const proofFile = path.join(temporaryRoot, 'transport.jsonl');
const negativeControl = process.argv.includes('--negative-control');
const noAuth = process.argv.includes('--no-auth');
const cliNegativeControl = process.argv.includes('--cli-negative-control');
assert.ok(!cliNegativeControl || noAuth, 'CLI negative control requires --no-auth');
let gateway;
let logFd;
const writeJson = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};
const events = () =>
  readFileSync(proofFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

try {
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', [
    '-C',
    root,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--allow-empty',
    '-qm',
    'fixture root',
  ]);
  for (const directory of ['pool', 'projects', 'scripts']) {
    mkdirSync(path.join(root, directory));
  }
  writeFileSync(path.join(root, 'CLAUDE.md'), '# Disposable grading proof\n');
  writeFileSync(path.join(root, 'scripts', 'dev.sh'), '#!/bin/sh\n');
  writeFileSync(proofFile, '');
  const bin = path.join(temporaryRoot, 'bin');
  mkdirSync(bin);
  // Fake executables exercise the real CLI transport without launching models.
  const cli = `#!${process.execPath}
const fs = require('node:fs');
const input = fs.readFileSync(0, 'utf8');
const event = input.includes('Grade this bug:') ? 'grading-cli' : 'summary-cli';
fs.appendFileSync(process.env.GRADING_PROOF_FILE, JSON.stringify({ event }) + '\\n');
process.stdout.write(JSON.stringify({ result: JSON.stringify({ summary: 'Correct warning copy', branchSlug: 'warning-copy' }) }));
`;
  for (const name of ['claude', 'codex']) {
    assert.ok(
      !existsSync(path.join(homedir(), '.asdf/shims', name)),
      `an asdf ${name} shim would override the fixture executable`,
    );
    writeFileSync(path.join(bin, name), cli, { mode: 0o755 });
  }
  writeJson(path.join(root, 'services/gateway/package.json'), {
    name: 'fixture',
    version: '0.0.0',
  });
  writeJson(path.join(root, 'projects', project, 'project.json'), {
    name: project,
    repo: root,
    hooks: {},
  });
  writeJson(path.join(temporaryRoot, 'home', 'llm-config.json'), {
    defaultProvider: noAuth ? 'grading-no-auth-fixture' : 'codex-lb',
    intelligenceModel: noAuth ? 'fast' : 'gpt-6-astra',
  });
  const timestamp = new Date().toISOString();
  writeJson(path.join(root, '.runs', `${runId}.json`), {
    id: runId,
    project,
    ticketOrPr: 'GRADING-1',
    flowType: 'fix-bug',
    mode: 'interactive',
    status: 'blocked',
    slotId: null,
    taskFile: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    decisions: [],
    grade: null,
    metrics: { nudgeCount: 0, runner: 'claude', model: 'opus' },
    ticketData: {
      source: 'manual',
      title: 'Correct warning copy',
      description: 'Use the specified warning for both order directions.',
      acceptanceCriteria: [],
      stepsToReproduce: [],
      affectedArea: '',
      screenshots: [],
      labels: [],
    },
    steps: FLOW_STEPS['fix-bug'].map((name) => ({
      name,
      status: name === 'find-slot' ? 'done' : 'pending',
    })),
  });
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    FARMSLOT_ROOT: root,
    FARMSLOT_HOME: path.join(temporaryRoot, 'home'),
    FARMSLOT_POOL_DIR: path.join(root, 'pool'),
    FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
    FARMSLOT_RUNS_DIR: path.join(root, '.runs'),
    FARMSLOT_CAPABILITY_STORE_FILE: path.join(root, '.runs/runtime-capabilities.json'),
    FARMSLOT_DISABLE_ORCHESTRATION: '1',
    FARMSLOT_DEMO_POOL: '0',
    GATEWAY_HOST: '127.0.0.1',
    GATEWAY_PORT: String(port),
    FARMSLOT_GATEWAY: `ws://127.0.0.1:${port}`,
    FARMSLOT_GATEWAY_TOKEN: randomUUID(),
    FARMSLOT_GATEWAY_PASSWORD: '',
    FARMSLOT_RPC_TIMEOUT_MS: '30000',
    CODEX_LB_API_KEY: 'synthetic-grading-proof-key',
    GRADING_PROOF_FILE: proofFile,
    GRADING_NEGATIVE_CONTROL: negativeControl ? '1' : '0',
    GRADING_CLI_NEGATIVE_CONTROL: cliNegativeControl ? '1' : '0',
    TSX_TSCONFIG_PATH: path.join(sourceRoot, 'services/gateway/tsconfig.json'),
  };
  logFd = openSync(path.join(temporaryRoot, 'gateway.log'), 'w');
  gateway = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--import',
      path.join(sourceRoot, 'scripts/runner-validation/gateway/grading-provider.mjs'),
      'services/gateway/src/index.ts',
    ],
    { cwd: sourceRoot, env, stdio: ['ignore', logFd, logFd] },
  );
  const rpc = (method, params) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        ['apps/command-center/scripts/cdp.mjs', 'gateway', method, JSON.stringify(params)],
        { cwd: sourceRoot, env, encoding: 'utf8', timeout: 45000 },
      ),
    );
  const startupDeadline = Date.now() + 120000;
  while (true) {
    assert.equal(gateway.exitCode, null, 'disposable gateway exited during startup');
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
    assert.ok(Date.now() < startupDeadline, 'disposable gateway must start');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  rpc('run.replayStep', { runId, stepName: 'grade', triggeredBy: 'operator' });
  const deadline = Date.now() + 90000;
  let run;
  while (Date.now() < deadline) {
    run = rpc('run.get', { runId }).run;
    if (run.steps.find((step) => step.name === 'write-task').status === 'failed') break;
    assert.notEqual(run.status, 'failed', 'grading must recover without failing the run');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const grade = run.steps.find((step) => step.name === 'grade');
  if (!noAuth) assert.ok(events().some((event) => event.event === 'grading-request'));
  assert.equal(grade.status, 'done', 'dispatch must advance past an unresponsive grading provider');
  if (noAuth) {
    assert.match(grade.outputs.gradingSkipped ?? '', /no API auth.*CLI fallback disabled/);
    assert.ok(!events().some((event) => event.event === 'grading-cli'));
    assert.ok(events().some((event) => event.event === 'summary-cli'));
  } else {
    assert.equal(grade.outputs.gradingSkipped, 'ticket grading timed out after 30000ms');
    assert.ok(events().some((event) => event.event === 'grading-aborted'));
    assert.ok(events().some((event) => event.event === 'summary-request'));
  }
  assert.equal(run.grade, null, 'recovery must not fabricate a grade');
  assert.equal(run.metrics.runner, 'claude');
  assert.equal(run.metrics.model, 'opus', 'recovery must preserve the explicitly selected model');
  const writeTask = run.steps.find((step) => step.name === 'write-task');
  assert.equal(writeTask.status, 'failed', 'the fixture must advance to task writing');
  assert.match(writeTask.detail, /No slot assigned.*cannot write task/);
  console.log(
    JSON.stringify({ passed: true, runId, gradingSkipped: grade.outputs.gradingSkipped }),
  );
} catch (error) {
  const logPath = path.join(temporaryRoot, 'gateway.log');
  if (existsSync(logPath)) console.error(readFileSync(logPath, 'utf8').slice(-5000));
  throw error;
} finally {
  if (gateway && gateway.exitCode === null) {
    const stopped = once(gateway, 'exit');
    gateway.kill('SIGTERM');
    const forced = setTimeout(() => gateway.kill('SIGKILL'), 5000);
    await stopped;
    clearTimeout(forced);
  }
  if (logFd !== undefined) closeSync(logFd);
  rmSync(temporaryRoot, { recursive: true, force: true });
}
