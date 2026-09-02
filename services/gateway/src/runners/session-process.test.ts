import assert from 'node:assert/strict';
import { execFile as execFileCb, spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

import {
  buildFindRunnerDescendantPidCommand,
  buildRunnerSessionDiscoveryCommand,
  findRunnerDescendantPid,
  readPaneProcessStartedAtMs,
  recaptureRunnerSessionMetadataIfMissing,
  resolvePersistedRunnerSessionBinding,
  resolvePromptBoundRunnerSession,
  resolveRetainedRunnerPane,
  resolveRunRetainedSessionBinding,
  retainedSessionSendOption,
  terminateRunnerDescendantsInTmuxSession,
  verifyExactLiveRunnerSessionBinding,
} from './session-process.js';
import { makeVars } from './test-fixtures.js';

const execFile = promisify(execFileCb);

test('runner descendant PID lookup preserves an indeterminate probe', async () => {
  await assert.rejects(
    findRunnerDescendantPid(makeVars(), '', 'cursor'),
    /Cannot determine runner liveness under pane PID/,
  );
});

test('runner descendant scan ignores the diagnostic wrapper after child exit', async () => {
  const wrapper = spawn(
    'bash',
    [
      '-c',
      [
        'false # codex --model gpt-5.5',
        '__farmslot_status=$?',
        'if [ "$__farmslot_status" -ne 0 ]; then',
        '  echo "[farmslot] runner launch command exited $__farmslot_status; preserving pane for diagnostics" >&2',
        '  sleep 30',
        'fi',
      ].join('\n'),
    ],
    { stdio: 'ignore' },
  );

  try {
    await sleep(100);
    const command = buildFindRunnerDescendantPidCommand(String(process.pid), 'codex');
    await assert.rejects(execFile('bash', ['-lc', command]), /Command failed/);
  } finally {
    wrapper.kill('SIGKILL');
  }
});

test('runner descendant scan returns the leaf runner instead of a matching shell wrapper', async () => {
  const wrapper = spawn('bash', ['-c', `bash -lc 'exec -a claude sleep 3' & wait`], {
    stdio: 'ignore',
  });

  try {
    await sleep(100);
    const command = buildFindRunnerDescendantPidCommand(String(wrapper.pid), 'claude');
    const { stdout } = await execFile('bash', ['-lc', command]);
    assert.match(stdout.trim(), /^\d+$/);
    assert.notEqual(stdout.trim(), String(wrapper.pid));
  } finally {
    wrapper.kill('SIGKILL');
  }
});

test('runner descendant scan prefers the runner executable over matching child arguments', async () => {
  const runner = spawn(
    'bash',
    ['-c', `exec -a claude bash -c 'node -e "setTimeout(() => {}, 3000)" claude & wait'`],
    { stdio: 'ignore' },
  );

  try {
    await sleep(100);
    const command = buildFindRunnerDescendantPidCommand(String(runner.pid), 'claude');
    const { stdout } = await execFile('bash', ['-lc', command]);
    assert.equal(stdout.trim(), String(runner.pid));
  } finally {
    runner.kill('SIGKILL');
  }
});

test('warm replacement terminates every pane runner without typing into composers', async () => {
  const commands: string[] = [];
  const probes = new Map<string, number>();
  const stopped = await terminateRunnerDescendantsInTmuxSession(makeVars(), 'mm-1', {
    exec: async (_vars, command) => {
      commands.push(command);
      if (command.includes('list-panes')) {
        return { exitCode: 0, stdout: '101\n202\n', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    probe: async (_vars, panePid) => {
      const count = probes.get(panePid) ?? 0;
      probes.set(panePid, count + 1);
      return count === 0
        ? { state: 'present', pid: panePid === '101' ? '110' : '220' }
        : { state: 'absent' };
    },
    sleep: async () => {},
  });

  assert.equal(stopped, 2);
  assert.ok(commands.some((command) => command.includes("kill -TERM '110'")));
  assert.ok(commands.some((command) => command.includes("kill -TERM '220'")));
  assert.equal(
    commands.some((command) => command.includes('send-keys')),
    false,
  );
});

test('warm replacement fails closed when tmux panes cannot be inspected', async () => {
  await assert.rejects(
    terminateRunnerDescendantsInTmuxSession(makeVars(), 'mm-1', {
      exec: async (_vars, command) =>
        command.includes('has-session')
          ? { exitCode: 0, stdout: '', stderr: '' }
          : { exitCode: 1, stdout: '', stderr: 'lost connection' },
    }),
    /tmux pane inspection failed.*lost connection/,
  );
});

test('warm replacement accepts a session confirmed absent after reservation', async () => {
  const stopped = await terminateRunnerDescendantsInTmuxSession(makeVars(), 'mm-1', {
    exec: async (_vars, command) =>
      command.includes('has-session')
        ? { exitCode: 1, stdout: '', stderr: '' }
        : { exitCode: 1, stdout: '', stderr: 'no session' },
  });
  assert.equal(stopped, 0);
});

test('warm replacement counts a retried runner PID once', async () => {
  let probes = 0;
  const stopped = await terminateRunnerDescendantsInTmuxSession(makeVars(), 'mm-1', {
    exec: async (_vars, command) =>
      command.includes('list-panes')
        ? { exitCode: 0, stdout: '101\n', stderr: '' }
        : { exitCode: 0, stdout: '', stderr: '' },
    probe: async () => {
      probes += 1;
      return probes <= 2 ? { state: 'present', pid: '110' } : { state: 'absent' };
    },
    sleep: async () => {},
  });

  assert.equal(stopped, 1);
});

test('warm replacement rechecks runner identity before SIGKILL escalation', async () => {
  const commands: string[] = [];
  let runnerProbes = 0;
  const stopped = await terminateRunnerDescendantsInTmuxSession(makeVars(), 'mm-1', {
    exec: async (_vars, command) => {
      commands.push(command);
      return command.includes('list-panes')
        ? { exitCode: 0, stdout: '101\n', stderr: '' }
        : { exitCode: 0, stdout: '', stderr: '' };
    },
    probe: async (_vars, _panePid, runnerId) => {
      if (runnerId === 'cursor') return { state: 'absent' };
      runnerProbes += 1;
      return runnerProbes === 1 ? { state: 'present', pid: '110' } : { state: 'absent' };
    },
    sleep: async () => {},
  });

  assert.equal(stopped, 1);
  assert.ok(commands.some((command) => command.includes("kill -TERM '110'")));
  assert.equal(
    commands.some((command) => command.includes("kill -KILL '110'")),
    false,
  );
});

test('warm replacement refuses an unattributed runner with a generic process name', async () => {
  const commands: string[] = [];
  await assert.rejects(
    terminateRunnerDescendantsInTmuxSession(makeVars(), 'mm-1', {
      exec: async (_vars, command) => {
        commands.push(command);
        return command.includes('list-panes')
          ? { exitCode: 0, stdout: '101\n', stderr: '' }
          : { exitCode: 0, stdout: '', stderr: '' };
      },
      probe: async (_vars, _panePid, runnerId) =>
        runnerId === 'cursor' ? { state: 'present', pid: '110' } : { state: 'absent' },
    }),
    /cursor process requires matching recorded runner identity/,
  );

  assert.equal(
    commands.some((command) => command.includes('kill -TERM')),
    false,
  );
});

test('warm replacement probes a declared custom runner before safe registered fallbacks', async () => {
  const runnerIds: Array<string | null | undefined> = [];
  let customSeen = false;
  const stopped = await terminateRunnerDescendantsInTmuxSession(makeVars(), 'mm-1', {
    exec: async (_vars, command) =>
      command.includes('list-panes')
        ? { exitCode: 0, stdout: '101\n', stderr: '' }
        : { exitCode: 0, stdout: '', stderr: '' },
    probe: async (_vars, _panePid, runnerId) => {
      runnerIds.push(runnerId);
      if (runnerId !== 'aider') return { state: 'absent' };
      if (!customSeen) {
        customSeen = true;
        return { state: 'present', pid: '110' };
      }
      return { state: 'absent' };
    },
    sleep: async () => {},
    additionalRunnerIds: ['aider'],
  });

  assert.equal(stopped, 1);
  assert.deepEqual(runnerIds.slice(0, 3), ['aider', 'aider', 'claude']);
});

test('nudge target resolution skips shells and reviewer panes, then picks the newest runner', async () => {
  const probes: string[] = [];
  const result = await resolveRetainedRunnerPane(makeVars(), 'mm-4', 'codex', 'mm-4:review', {
    exec: async (_vars, command) => {
      if (command.includes('list-panes')) {
        return {
          exitCode: 0,
          stdout: [
            '1|dev|0|300|100',
            '2|rev-codex|0|200|500',
            '3||0|400|400',
            '4|review|0|100|600',
            '5|ci-fix|0|500|700',
          ].join('\n'),
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    probe: async (_vars, panePid) => {
      probes.push(panePid);
      return panePid === '100' ? { state: 'absent' } : { state: 'present', pid: panePid };
    },
  });

  assert.equal(result?.target, 'mm-4:3.0');
  assert.equal(result?.window, '3');
  assert.equal(probes.includes('200'), false, 'dedicated reviewer panes must not receive nudges');
  assert.equal(probes.includes('500'), false, 'CI fix panes must not receive nudges');
});

test('nudge target resolution fails closed when runner liveness is unknown', async () => {
  await assert.rejects(
    resolveRetainedRunnerPane(makeVars(), 'mm-4', 'codex', null, {
      exec: async () => ({
        exitCode: 0,
        stdout: '1|dev|0|300|100\n2|bugfix|0|400|200',
        stderr: '',
      }),
      probe: async () => ({ state: 'unknown', reason: 'ssh timeout' }),
    }),
    /Cannot inspect retained runner.*ssh timeout/,
  );
});

test('persisted runner session binding selects id and path from one source', () => {
  assert.deepEqual(
    resolvePersistedRunnerSessionBinding([
      { label: 'context' },
      {
        label: 'parent metrics',
        runnerSessionId: ' session-parent ',
        runnerSessionPath: ' /sessions/parent.jsonl ',
      },
      {
        label: 'requesting metrics',
        runnerSessionId: 'session-requesting',
        runnerSessionPath: '/sessions/requesting.jsonl',
      },
    ]),
    {
      binding: {
        runnerSessionId: 'session-parent',
        runnerSessionPath: '/sessions/parent.jsonl',
      },
      reason: null,
    },
  );
});

test('persisted runner session binding rejects a partial higher-priority source', () => {
  assert.deepEqual(
    resolvePersistedRunnerSessionBinding([
      { label: 'context', runnerSessionId: 'session-context' },
      {
        label: 'parent metrics',
        runnerSessionId: 'session-parent',
        runnerSessionPath: '/sessions/parent.jsonl',
      },
    ]),
    {
      binding: null,
      reason: 'context has incomplete retained session metadata',
      incompleteBinding: true,
    },
  );
});

test('run retained session binding marks a missing agent context as safe for fresh delivery', () => {
  const result = resolveRunRetainedSessionBinding(
    {
      metrics: {
        runnerSessionId: 'metrics-session',
        runnerSessionPath: '/sessions/metrics.jsonl',
      },
      agentContexts: [],
    },
    null,
  );

  // An absent context record carries no half identity, so callers may deliver
  // through the fresh post-launch contract instead of failing closed.
  assert.equal(result.binding, null);
  assert.equal(result.incompleteBinding, undefined);
});

test('run retained session binding prefers the selected agent context', () => {
  assert.deepEqual(
    resolveRunRetainedSessionBinding(
      {
        metrics: {
          runnerSessionId: 'metrics-session',
          runnerSessionPath: '/sessions/metrics.jsonl',
        },
        agentContexts: [],
      },
      {
        runnerSessionId: 'context-session',
        runnerSessionPath: '/sessions/context.jsonl',
      },
    ),
    {
      binding: {
        runnerSessionId: 'context-session',
        runnerSessionPath: '/sessions/context.jsonl',
      },
      reason: null,
    },
  );
});

test('run retained session binding does not borrow metrics for an unbound selected context', () => {
  const result = resolveRunRetainedSessionBinding(
    {
      metrics: {
        runnerSessionId: 'metrics-session',
        runnerSessionPath: '/sessions/metrics.jsonl',
      },
      agentContexts: [],
    },
    { runnerSessionId: null, runnerSessionPath: null },
  );

  assert.deepEqual(result, { binding: null, reason: null });
  assert.deepEqual(retainedSessionSendOption(result), {});
});

test('retained session send option maps one atomic binding', () => {
  assert.deepEqual(
    retainedSessionSendOption({
      binding: {
        runnerSessionId: 'session-1',
        runnerSessionPath: '/sessions/session-1.jsonl',
      },
      reason: null,
    }),
    {
      retainedSession: {
        sessionId: 'session-1',
        sessionPath: '/sessions/session-1.jsonl',
      },
    },
  );
});

test('post-prompt capture recovers an initially late exact runner session binding', async () => {
  const captureOptions = {
    sinceMs: 100,
    observedNotBeforeMs: 120,
    paneId: '%20',
    slotId: 'mini-ff-1',
  };
  let calls = 0;
  const result = await recaptureRunnerSessionMetadataIfMissing(
    makeVars({ slotId: 'mini-ff-1' }),
    'codex',
    ['/sessions/pre-existing.jsonl'],
    { runnerSessionId: null, runnerSessionPath: null },
    captureOptions,
    async (_vars, runner, beforePaths, options) => {
      calls += 1;
      assert.equal(runner, 'codex');
      assert.deepEqual(beforePaths, ['/sessions/pre-existing.jsonl']);
      assert.deepEqual(options, captureOptions);
      return {
        runnerSessionId: '01a0203f-4495-7f42-a499-abbe0d93f9e2',
        runnerSessionPath: '/sessions/late.jsonl',
      };
    },
  );

  assert.equal(calls, 1);
  assert.deepEqual(result, {
    runnerSessionId: '01a0203f-4495-7f42-a499-abbe0d93f9e2',
    runnerSessionPath: '/sessions/late.jsonl',
  });
});

test('post-prompt capture never borrows half a binding from the pre-prompt attempt', async () => {
  const result = await recaptureRunnerSessionMetadataIfMissing(
    makeVars(),
    'codex',
    [],
    { runnerSessionId: 'pre-prompt-id', runnerSessionPath: null },
    {},
    async () => ({ runnerSessionId: null, runnerSessionPath: '/sessions/post-prompt.jsonl' }),
  );

  assert.deepEqual(result, { runnerSessionId: null, runnerSessionPath: null });
});

test('Codex discovery searches isolated and global session roots', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runner-session-roots-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const fakeHome = path.join(root, 'home');
  const isolated = path.join(repo, 'runtime/codex-home/sessions/isolated.jsonl');
  const global = path.join(fakeHome, '.codex/sessions/global.jsonl');
  await Promise.all([
    mkdir(path.dirname(isolated), { recursive: true }),
    mkdir(path.dirname(global), { recursive: true }),
  ]);
  const session = (id: string) =>
    `${JSON.stringify({ type: 'session_meta', payload: { id, cwd: repo } })}\n`;
  await Promise.all([
    writeFile(isolated, session('isolated')),
    writeFile(global, session('global')),
  ]);

  const command = buildRunnerSessionDiscoveryCommand(repo, 'codex', 'runtime', fakeHome);
  const { stdout } = await execFile('bash', ['-c', command]);
  assert.deepEqual(
    new Set(JSON.parse(stdout)),
    new Set(await Promise.all([realpath(isolated), realpath(global)])),
  );
});

test('prompt-bound fallback attributes one initially late global Codex session exactly', async () => {
  const latePath = '/home/test/.codex/sessions/late.jsonl';
  const unrelatedPath = '/repo/runtime/codex-home/sessions/unrelated.jsonl';
  const result = await resolvePromptBoundRunnerSession(
    makeVars({ slotId: 'mini-ff-1' }),
    'codex',
    ['/repo/runtime/codex-home/sessions/pre-existing.jsonl'],
    {
      sinceMs: 1_000,
      paneId: '%20',
      promptText: 'Read and execute the exact TASK.md',
      promptAcceptedSinceMs: 1_500,
    },
    {
      listSessionFiles: async () => [unrelatedPath, latePath],
      loadMtimes: async () =>
        new Map([
          [unrelatedPath, 2_000],
          [latePath, 2_100],
        ]),
      resolveSessionId: async (_vars, _runner, sessionPath) =>
        sessionPath === latePath ? 'late-session' : 'unrelated-session',
      promptAcceptedInSession: async (_vars, _runner, target, sessionId, sessionPath) => {
        assert.equal(target, '%20');
        return sessionPath === latePath
          ? {
              value: true,
              source: 'signal',
              confidence: 'high',
              observedAt: 2_100,
              exactPromptMatch: true,
              sessionId,
            }
          : null;
      },
    },
  );

  assert.deepEqual(result, {
    runnerSessionId: 'late-session',
    runnerSessionPath: latePath,
    source: 'native',
  });
});

test('prompt-bound fallback rejects two concurrent exact prompt matches', async () => {
  const paths = ['/sessions/one.jsonl', '/sessions/two.jsonl'];
  const result = await resolvePromptBoundRunnerSession(
    makeVars(),
    'codex',
    [],
    { promptText: 'same prompt', promptAcceptedSinceMs: 1_000 },
    {
      listSessionFiles: async () => paths,
      loadMtimes: async () => new Map(paths.map((sessionPath) => [sessionPath, 2_000])),
      resolveSessionId: async (_vars, _runner, sessionPath) => sessionPath,
      promptAcceptedInSession: async (_vars, _runner, _target, sessionId) => ({
        value: true,
        source: 'signal',
        confidence: 'high',
        observedAt: 2_000,
        exactPromptMatch: true,
        sessionId,
      }),
    },
  );

  assert.equal(result, null);
});

test('exact live binding verifier supports Claude, Codex, and Grok pane-native attribution', async () => {
  type VerifyDeps = NonNullable<Parameters<typeof verifyExactLiveRunnerSessionBinding>[3]>;
  for (const runner of ['claude', 'codex', 'grok']) {
    const deps: VerifyDeps = {
      readPaneStartedAt: async () => 1_000,
      resolveBinding: async (_vars, resolvedRunner, _before, options) => {
        assert.equal(resolvedRunner, runner);
        assert.equal(options?.paneId, '%20');
        return {
          runnerSessionId: `${runner}-session`,
          runnerSessionPath: `/alias/${runner}-session.jsonl`,
          source: runner === 'codex' ? 'native' : 'hook',
        };
      },
      canonicalizePath: async (_vars, sessionPath) =>
        sessionPath.replace('/alias/', '/canonical/').replace('/persisted/', '/canonical/'),
    };
    const result = await verifyExactLiveRunnerSessionBinding(
      makeVars(),
      runner,
      {
        paneId: '%20',
        slotId: 'slot-1',
        expectedSessionId: `${runner}-session`,
        expectedSessionPath: `/persisted/${runner}-session.jsonl`,
      },
      deps,
    );
    assert.equal(result.ok, true, `${runner} should accept its exact live binding`);
    if (result.ok)
      assert.equal(result.binding.canonicalSessionPath.startsWith('/canonical/'), true);
  }
});

test('exact live binding verifier rejects a new same-runner session in the persisted pane', async () => {
  const result = await verifyExactLiveRunnerSessionBinding(
    makeVars(),
    'codex',
    {
      paneId: '%20',
      slotId: 'slot-1',
      expectedSessionId: 'parked-session',
      expectedSessionPath: '/sessions/parked-session.jsonl',
    },
    {
      readPaneStartedAt: async () => 2_000,
      resolveBinding: async () => ({
        runnerSessionId: 'new-session',
        runnerSessionPath: '/sessions/new-session.jsonl',
        source: 'native',
      }),
      canonicalizePath: async (_vars, sessionPath) => sessionPath,
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok)
    assert.match(result.reason, /new-session.*does not match persisted.*parked-session/);
});

test('pane process start is resolved from the live tmux pane', async () => {
  const session = `farmslot-pane-start-${process.pid}`;
  let created = false;
  try {
    await execFile('tmux', ['new-session', '-d', '-s', session, 'sleep 30']);
    created = true;
    const paneId = (
      await execFile('tmux', ['display-message', '-p', '-t', session, '#{pane_id}'])
    ).stdout.trim();
    const startedAt = await readPaneProcessStartedAtMs(
      makeVars({ remoteRepo: process.cwd() }),
      paneId,
    );
    assert.ok(startedAt !== null && Math.abs(Date.now() - startedAt) < 60_000);
  } finally {
    if (created) await execFile('tmux', ['kill-session', '-t', session]);
  }
});
