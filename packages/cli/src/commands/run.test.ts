import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { WebSocketServer } from 'ws';

import type { Run } from '@farmslot/protocol';

import {
  assertRunGateActionAvailable,
  buildReviewChainResult,
  buildRunCreateParams,
  formatReviewChainLine,
  formatRunSessionLines,
  parseAgentRole,
  parseOptionalPrNumber,
  parseTaskPath,
} from './run.js';

function repeatReviewRun(): Run {
  return {
    id: 'review-run-2',
    familyId: 'review-family',
    lane: 'production',
    flowType: 'review-pr',
    status: 'done',
    project: 'farmslot-farm',
    ticketOrPr: 'deeeed/farmslot#505',
    slotId: 'mini-ff-1',
    branch: 'feat/review',
    taskFile: null,
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, runner: 'codex', model: 'gpt-5.6' },
    repeatReviewContext: {
      version: 1,
      chainId: 'review-run-1',
      generation: 2,
      priorRunId: 'review-run-1',
      priorFamilyId: 'review-family',
      repository: 'deeeed/farmslot',
      prNumber: 505,
      priorReviewedHeadSha: '111111111111',
      currentHeadSha: '222222222222',
      verdict: 'pending',
      unresolvedFindings: [],
      artifactRefs: [],
      farmslotEvidenceRefs: [],
      contextMode: 'reuse',
      reviewScope: 'incremental',
      validationDepth: 'static-code',
      sessionIntent: 'resume',
      session: {
        intent: 'resume',
        continuity: 'resumed',
        priorRunId: 'review-run-1',
        priorSessionId: 'session-1',
        sessionId: 'session-1',
      },
    },
    createdAt: '2026-08-07T00:00:00.000Z',
    updatedAt: '2026-08-07T00:00:00.000Z',
  };
}

test('run review-chain exposes stable JSON and human output shapes', () => {
  const result = buildReviewChainResult(repeatReviewRun());

  assert.equal(result.chain.length, 1);
  assert.equal(result.chain[0]?.generation, 2);
  assert.equal(result.chain[0]?.session?.continuity, 'resumed');
  assert.equal(
    formatReviewChainLine(result.chain[0]!),
    'G2 review-r  1111111 -> 2222222  incremental/static-code  pending  unresolved pending  resumed',
  );
});

test('parseOptionalPrNumber accepts a positive integer and rejects the rest', () => {
  assert.equal(parseOptionalPrNumber(undefined), undefined);
  assert.equal(parseOptionalPrNumber(''), undefined);
  assert.equal(parseOptionalPrNumber('35145'), 35145);
  assert.throws(() => parseOptionalPrNumber('0'), /--pr must be a positive integer/);
  assert.throws(() => parseOptionalPrNumber('1.5'), /--pr must be a positive integer/);
});

test('run gate rejects actions that the pending decision does not offer', () => {
  const decision = {
    id: 'decision-1',
    type: 'engine_human_gate',
    title: 'Publish gate',
    description: 'Review package',
    actions: [
      { id: 'hold', label: 'Hold', style: 'secondary' },
      { id: 'approve-publish', label: 'Publish', style: 'primary' },
    ],
    createdAt: '2026-07-31T00:00:00.000Z',
  } as NonNullable<import('@farmslot/protocol').Run['decisions']>[number];

  assert.doesNotThrow(() => assertRunGateActionAvailable(decision, 'approve-publish'));
  assert.throws(
    () => assertRunGateActionAvailable(decision, 'request-extra-review'),
    /Available actions: hold, approve-publish/,
  );
});

test('run create builds params from a GitHub/Jira ticket source', () => {
  assert.deepEqual(
    buildRunCreateParams({
      project: 'audiolab-farm',
      flowType: 'dev',
      ticket: 'https://github.com/deeeed/audiolab/issues/414',
      slot: 'mini-audiolab-1',
      runner: 'codex',
    }),
    {
      project: 'audiolab-farm',
      flowType: 'dev',
      ticketOrPr: 'https://github.com/deeeed/audiolab/issues/414',
      slotId: 'mini-audiolab-1',
      runner: 'codex',
      skipPrepare: undefined,
      prepareProfile: undefined,
      mode: undefined,
      model: undefined,
      app: undefined,
      familyId: undefined,
      parentRunId: undefined,
      familyRootTicketOrPr: undefined,
      lane: undefined,
      variant: undefined,
    },
  );
});

test('run create omits the domain key entirely unless --domain is given', () => {
  const withoutDomain = buildRunCreateParams({
    project: 'audiolab-farm',
    flowType: 'dev',
    ticket: 'DEMO-414',
  });
  assert.equal('domain' in withoutDomain, false);

  const withDomain = buildRunCreateParams({
    project: 'audiolab-farm',
    flowType: 'dev',
    ticket: 'DEMO-414',
    domain: 'blue',
  });
  assert.equal(withDomain.domain, 'blue');
});

test('run create carries an exact execution-template id only when requested', () => {
  const params = buildRunCreateParams({
    project: 'example',
    flowType: 'fix-bug',
    ticket: 'PROJ-123',
    executionTemplate: 'fix-bug/trading-mobile',
  });
  assert.equal(params.executionTemplateId, 'fix-bug/trading-mobile');
});

test('run create builds params from an existing task file source', () => {
  assert.deepEqual(
    buildRunCreateParams({
      task: 'projects/audiolab-farm/tasks/dev/demo-414-0604/TASK.md',
      slot: 'mini-audiolab-1',
    }),
    {
      project: 'audiolab-farm',
      flowType: 'dev',
      ticketOrPr: 'DEMO-414',
      taskFile: 'projects/audiolab-farm/tasks/dev/demo-414-0604/TASK.md',
      slotId: 'mini-audiolab-1',
      skipPrepare: undefined,
      prepareProfile: undefined,
      mode: undefined,
      runner: undefined,
      model: undefined,
      app: undefined,
      familyId: undefined,
      parentRunId: undefined,
      familyRootTicketOrPr: undefined,
      lane: undefined,
      variant: undefined,
    },
  );
});

test('run create forwards comparison lineage metadata', () => {
  assert.deepEqual(
    buildRunCreateParams({
      project: 'audiolab-farm',
      flowType: 'dev',
      ticket: 'DEMO-414',
      slot: 'mini-audiolab-1',
      runner: 'codex',
      model: 'gpt-5.5',
      familyId: 'family-1',
      parentRunId: 'parent-1',
      familyRootTicketOrPr: 'DEMO-414',
      lane: 'comparison',
      variant: 'comparison-codex',
    }),
    {
      project: 'audiolab-farm',
      flowType: 'dev',
      ticketOrPr: 'DEMO-414',
      slotId: 'mini-audiolab-1',
      runner: 'codex',
      model: 'gpt-5.5',
      skipPrepare: undefined,
      prepareProfile: undefined,
      mode: undefined,
      app: undefined,
      familyId: 'family-1',
      parentRunId: 'parent-1',
      familyRootTicketOrPr: 'DEMO-414',
      lane: 'comparison',
      variant: 'comparison-codex',
    },
  );
});

test('run create rejects ambiguous input sources', () => {
  assert.throws(
    () =>
      buildRunCreateParams({
        project: 'audiolab-farm',
        flowType: 'dev',
        ticket: 'DEMO-414',
        task: 'projects/audiolab-farm/tasks/dev/demo-414-0604/TASK.md',
      }),
    /either --ticket or --task/,
  );
});

test('parseTaskPath maps task directories to run fields', () => {
  assert.deepEqual(parseTaskPath('/tmp/repo/projects/foo/tasks/fix/proj-2483-0409/TASK.md'), {
    project: 'foo',
    flowType: 'fix-bug',
    ticketOrPr: 'PROJ-2483',
    relativePath: 'projects/foo/tasks/fix/proj-2483-0409/TASK.md',
  });
});

test('parseTaskPath uses generated task provenance over folder naming', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'farmslot-task-'));
  const taskDir = path.join(root, 'projects/audiolab-farm/tasks/feat/414-0604-141246');
  mkdirSync(path.join(taskDir, 'inputs'), { recursive: true });
  const taskFile = path.join(taskDir, 'TASK.md');
  writeFileSync(taskFile, '# Task\n');
  writeFileSync(
    path.join(taskDir, 'inputs/template-provenance.json'),
    JSON.stringify({ flowType: 'dev' }),
  );
  writeFileSync(
    path.join(taskDir, 'inputs/bug-input.json'),
    JSON.stringify({ githubIssue: 'deeeed/audiolab#414' }),
  );

  assert.deepEqual(parseTaskPath(taskFile), {
    project: 'audiolab-farm',
    flowType: 'dev',
    ticketOrPr: 'deeeed/audiolab#414',
    relativePath: 'projects/audiolab-farm/tasks/feat/414-0604-141246/TASK.md',
  });
});

test('run create canonicalizes an absolute task file to the gateway-relative path', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'farmslot-task-'));
  const taskDir = path.join(root, 'projects/audiolab-farm/tasks/feat/414-0604-141246');
  mkdirSync(path.join(taskDir, 'inputs'), { recursive: true });
  const taskFile = path.join(taskDir, 'TASK.md');
  writeFileSync(taskFile, '# Task\n');
  writeFileSync(
    path.join(taskDir, 'inputs/template-provenance.json'),
    JSON.stringify({ flowType: 'dev' }),
  );
  writeFileSync(
    path.join(taskDir, 'inputs/bug-input.json'),
    JSON.stringify({ githubIssue: 'deeeed/audiolab#414' }),
  );

  assert.equal(
    buildRunCreateParams({ task: taskFile }).taskFile,
    'projects/audiolab-farm/tasks/feat/414-0604-141246/TASK.md',
  );
});

test('parseTaskPath ignores unrelated parent directories named projects', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'farmslot-parent-projects-'));
  const taskDir = path.join(
    root,
    'projects',
    'farmslot',
    'projects/audiolab-farm/tasks/feat/414-0604-141246',
  );
  mkdirSync(path.join(taskDir, 'inputs'), { recursive: true });
  const taskFile = path.join(taskDir, 'TASK.md');
  writeFileSync(taskFile, '# Task\n');
  writeFileSync(
    path.join(taskDir, 'inputs/template-provenance.json'),
    JSON.stringify({ flowType: 'dev' }),
  );
  writeFileSync(
    path.join(taskDir, 'inputs/bug-input.json'),
    JSON.stringify({ githubIssue: 'deeeed/audiolab#414' }),
  );

  assert.deepEqual(parseTaskPath(taskFile), {
    project: 'audiolab-farm',
    flowType: 'dev',
    ticketOrPr: 'deeeed/audiolab#414',
    relativePath: 'projects/audiolab-farm/tasks/feat/414-0604-141246/TASK.md',
  });
});

test('parseTaskPath ignores earlier parent projects tasks sequences', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'farmslot-parent-projects-tasks-'));
  const taskDir = path.join(
    root,
    'projects',
    'parent',
    'tasks',
    'not-a-flow',
    'not-a-task',
    'projects/audiolab-farm/tasks/feat/414-0604-141246',
  );
  mkdirSync(path.join(taskDir, 'inputs'), { recursive: true });
  const taskFile = path.join(taskDir, 'TASK.md');
  writeFileSync(taskFile, '# Task\n');
  writeFileSync(
    path.join(taskDir, 'inputs/template-provenance.json'),
    JSON.stringify({ flowType: 'dev' }),
  );
  writeFileSync(
    path.join(taskDir, 'inputs/bug-input.json'),
    JSON.stringify({ githubIssue: 'deeeed/audiolab#414' }),
  );

  assert.deepEqual(parseTaskPath(taskFile), {
    project: 'audiolab-farm',
    flowType: 'dev',
    ticketOrPr: 'deeeed/audiolab#414',
    relativePath: 'projects/audiolab-farm/tasks/feat/414-0604-141246/TASK.md',
  });
});

test('parseTaskPath uses generated Jira key metadata over folder naming', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'farmslot-task-'));
  const taskDir = path.join(root, 'projects/metamask-mobile/tasks/fix/3215-0604-141246');
  mkdirSync(path.join(taskDir, 'inputs'), { recursive: true });
  const taskFile = path.join(taskDir, 'TASK.md');
  writeFileSync(taskFile, '# Task\n');
  writeFileSync(
    path.join(taskDir, 'inputs/bug-input.json'),
    JSON.stringify({ jiraKey: 'TAT-3215' }),
  );

  assert.deepEqual(parseTaskPath(taskFile), {
    project: 'metamask-mobile',
    flowType: 'fix-bug',
    ticketOrPr: 'TAT-3215',
    relativePath: 'projects/metamask-mobile/tasks/fix/3215-0604-141246/TASK.md',
  });
});

test('parseTaskPath reports malformed task metadata with file context', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'farmslot-task-'));
  const taskDir = path.join(root, 'projects/audiolab-farm/tasks/feat/414-0604-141246');
  mkdirSync(path.join(taskDir, 'inputs'), { recursive: true });
  const taskFile = path.join(taskDir, 'TASK.md');
  writeFileSync(taskFile, '# Task\n');
  writeFileSync(path.join(taskDir, 'inputs/template-provenance.json'), '{bad json');

  assert.throws(() => parseTaskPath(taskFile), /Invalid task metadata .*template-provenance\.json/);
});

test('run create builds scripted scenario config', () => {
  const params = buildRunCreateParams({
    project: 'farmslot-farm',
    flowType: 'dev',
    ticket: 'DEV-1',
    runner: 'scripted',
    scriptedScenario: 'success',
    scriptedStepDelayMs: '0',
  });

  assert.deepEqual(params.scripted, { mode: 'scenario', scenario: 'success', stepDelayMs: 0 });
});

test('run create rejects ambiguous scripted config', () => {
  assert.throws(
    () =>
      buildRunCreateParams({
        project: 'farmslot-farm',
        flowType: 'dev',
        ticket: 'DEV-1',
        runner: 'scripted',
        scriptedScenario: 'success',
        scriptedCommandRef: 'smoke',
      }),
    /either --scripted-scenario or --scripted-command-ref/,
  );
});

test('run create forwards the preview identity when pressure flags are given', () => {
  const params = buildRunCreateParams({
    project: 'farmslot-farm',
    flowType: 'fix-bug',
    ticket: 'PROJ-1',
    pressureMachine: 'macwork',
    pressureGeneration: 'macwork|gen-a|3|2026-08-21T09:59:30.000Z',
  });
  assert.deepEqual(params.pressureAdmissionRef, {
    machine: 'macwork',
    pressureGeneration: 'macwork|gen-a|3|2026-08-21T09:59:30.000Z',
  });
  assert.equal(params.pressureOverride, undefined);
});

test('run create builds a one-dispatch override when a reason is supplied', () => {
  const params = buildRunCreateParams({
    project: 'farmslot-farm',
    flowType: 'fix-bug',
    ticket: 'PROJ-1',
    pressureMachine: 'macwork',
    pressureGeneration: 'gen-x',
    pressureOverrideReason: 'urgent hotfix',
  });
  assert.deepEqual(params.pressureOverride, {
    machine: 'macwork',
    pressureGeneration: 'gen-x',
    reason: 'urgent hotfix',
  });
  assert.equal(params.pressureAdmissionRef, undefined);
});

test('run create refuses partial pressure flags', () => {
  assert.throws(
    () =>
      buildRunCreateParams({
        project: 'farmslot-farm',
        flowType: 'fix-bug',
        ticket: 'PROJ-1',
        pressureOverrideReason: 'urgent hotfix',
      }),
    /--pressure-machine and --pressure-generation/,
  );
});

test('run session prints the reopen and attach commands on their own lines', () => {
  const lines = formatRunSessionLines({
    supported: true,
    runId: 'run-1',
    role: 'fix-bug',
    contextId: 'fix-bug',
    runner: 'codex',
    model: 'gpt-5.6',
    sessionId: 'codex-session-123',
    sessionPath: '/repo/.agent/codex/sessions/codex-session-123.jsonl',
    capturedAt: '2026-09-04T09:00:00.000Z',
    slotId: 'macpro-mm-1',
    machine: 'macpro',
    tmuxTarget: 'mm-1:dev',
    interrupt: { command: '/exit', submitDelayMs: 50 },
    reopenCommand: "cd /repo && CODEX_HOME=/repo/.agent/codex codex resume 'codex-session-123'",
    attachCommand: "tmux select-window -t 'mm-1:dev' \\; attach -t '=mm-1'",
    liveness: 'dead',
  });

  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /codex\/gpt-5\.6/);
  assert.match(lines[0]!, /context=fix-bug/);
  assert.match(lines[0]!, /liveness=dead/);
  assert.equal(
    lines[1],
    "cd /repo && CODEX_HOME=/repo/.agent/codex codex resume 'codex-session-123'",
  );
  assert.equal(lines[2], "tmux select-window -t 'mm-1:dev' \\; attach -t '=mm-1'");
});

test('run session reports an unsupported runner instead of printing a guessed command', () => {
  const lines = formatRunSessionLines({
    supported: false,
    runId: 'run-1',
    role: 'fix-bug',
    reason: 'session-reload-unsupported',
    detail: "Runner 'cursor' has no validated session reload.",
  });

  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /session-reload-unsupported/);
  assert.match(lines[1]!, /cursor/);
});

test('parseAgentRole accepts a known role and rejects the rest', () => {
  assert.equal(parseAgentRole(undefined), undefined);
  assert.equal(parseAgentRole(''), undefined);
  assert.equal(parseAgentRole('self-review'), 'self-review');
  assert.throws(() => parseAgentRole('reviewer'), /Invalid --role 'reviewer'/);
});

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(packageDir, '../..');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const cliEntry = path.join(packageDir, 'src', 'entry.ts');

function spawnRunCli(
  args: string[],
  home: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsxBin, [cliEntry, ...args], {
      cwd: packageDir,
      env: { ...process.env, FARMSLOT_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('CLI fixture timed out'));
    }, 30_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

test('run session --json forwards the exact context and returns the RPC result verbatim', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const payload = {
    supported: true,
    runId: 'run-1',
    role: 'self-review',
    contextId: 'rev2-codex',
    runner: 'codex',
    model: 'gpt-5.6',
    sessionId: 'reviewer-session-2',
    sessionPath: '/repo/.agent/codex/sessions/reviewer-session-2.jsonl',
    capturedAt: '2026-09-04T09:20:00.000Z',
    slotId: 'macpro-mm-1',
    machine: 'macpro',
    tmuxTarget: 'mm-1:rev2-codex',
    interrupt: { command: '/exit', submitDelayMs: 50 },
    reopenCommand: "CODEX_HOME=/repo/.agent/codex codex resume 'reviewer-session-2'",
    attachCommand: "tmux select-window -t 'mm-1:rev2-codex' \; attach -t '=mm-1'",
    liveness: 'live',
  };

  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  server.on('connection', (socket) => {
    socket.on('message', (data) => {
      const request = JSON.parse(String(data)) as {
        id: string;
        method: string;
        params: Record<string, unknown>;
      };
      if (request.method === 'auth.connect') {
        socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload: {} }));
        return;
      }
      calls.push({ method: request.method, params: request.params });
      socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload }));
    });
  });

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `ws://127.0.0.1:${address.port}`;
  const home = mkdtempSync(path.join(tmpdir(), 'farmslot-run-session-'));
  try {
    const result = await spawnRunCli(
      [
        '--url',
        url,
        '--timeout',
        '3000',
        '--json',
        'run',
        'session',
        'run-1',
        '--context',
        'rev2-codex',
        '--role',
        'self-review',
      ],
      home,
    );

    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout) as { status: string; data: typeof payload };
    assert.equal(envelope.status, 'ok');
    assert.deepEqual(envelope.data, payload);
    assert.deepEqual(
      calls.map((call) => call.method),
      ['run.sessionCommand'],
    );
    // The exact context must reach the gateway; role alone would resolve to
    // whichever reviewer is newest.
    assert.equal(calls[0]!.params.contextId, 'rev2-codex');
    assert.equal(calls[0]!.params.role, 'self-review');
    assert.equal(calls[0]!.params.runId, 'run-1');
  } finally {
    rmSync(home, { recursive: true, force: true });
    server.close();
  }
});
