// Opt-in proof with one owned Codex TUI and a disposable authenticated Gateway. No farm dispatch.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Methods } from '@farmslot/protocol';

import { createNativeProofFixture } from './native-proof-fixture.live-support.js';

test(
  'terminal and farm sends require native prompt acceptance on a real Codex terminal',
  { timeout: 180_000 },
  async (t) => {
    const output = process.env.FARMSLOT_TERMINAL_SUBMISSION_PROOF_OUT;
    const negativeOnly = process.env.FARMSLOT_TERMINAL_SUBMISSION_NEGATIVE === '1';
    const sandbox = process.env.FARMSLOT_TMUX_SANDBOX;
    assert.ok(output && sandbox && process.env.TMUX_TMPDIR);
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, 'proof.json'), JSON.stringify({ status: 'fail' }) + '\n');
    const root = await mkdtemp(path.join(os.tmpdir(), 'terminal-submit-rpc-'));
    const workspaceId = `submit-${randomUUID()}`;
    const session = `review-${workspaceId}`;
    const tmux = (...args: string[]) =>
      execFileSync('tmux', ['-S', sandbox, ...args], { encoding: 'utf8' }).trim();
    let started = false;
    const pausedPids: number[] = [];
    t.after(async () => {
      for (const pid of pausedPids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (error) {
          // Killing a parent can already have ended its owned child.
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH')
            throw error;
        }
      }
      if (started) {
        const exists = spawnSync('tmux', ['-S', sandbox, 'has-session', '-t', session]);
        if (exists.status === 1) return; // The owned CLI already exited before cleanup.
        assert.equal(exists.status, 0);
        await writeFile(
          path.join(output, 'terminal-diagnostic.txt'),
          tmux('capture-pane', '-p', '-t', session),
        );
        assert.equal(
          tmux('show-option', '-v', '-t', session, '@farmslot-review-workspace'),
          workspaceId,
        );
        tmux('kill-session', '-t', session);
      }
    });
    for (const key of Object.keys(process.env))
      if (
        (/^(FARMSLOT_|GATEWAY_|GIT_CONFIG)/.test(key) && key !== 'FARMSLOT_TMUX_SANDBOX') ||
        key === 'TMUX' ||
        key === 'TMUX_PANE'
      )
        delete process.env[key];
    Object.assign(process.env, {
      NODE_TEST_CONTEXT: '1',
      GATEWAY_HOST: '127.0.0.1',
      FARMSLOT_ROOT: root,
      FARMSLOT_HOME: path.join(root, 'home'),
      FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
      FARMSLOT_POOL_DIR: path.join(root, 'pool'),
      FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
      FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
    });
    for (const dir of [
      'home',
      'runs',
      'pool',
      'scripts',
      'services/gateway',
      'projects/proof/repo',
      'projects/proof/task',
      'projects/proof/artifacts',
    ])
      await mkdir(path.join(root, dir), { recursive: true });
    await writeFile(path.join(root, 'CLAUDE.md'), '# Disposable submission proof\n');
    await writeFile(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\n');
    await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
    await symlink(
      fileURLToPath(new URL('../../../../schemas', import.meta.url)),
      path.join(root, 'schemas'),
    );
    await writeFile(
      path.join(root, 'projects/proof/project.json'),
      JSON.stringify({ name: 'proof' }),
    );
    await writeFile(
      path.join(root, 'pool/proof.json'),
      JSON.stringify({
        machine: 'submission-proof',
        host: 'localhost',
        project: 'proof',
        platform: 'cli',
        slots: [],
      }),
    );
    const noPty = () => {
      throw new Error('This proof uses the owned tmux session, never a PTY attachment');
    };
    mock.module('./pty-stream.js', {
      namedExports: {
        onPtyExit: () => {},
        hasPty: () => false,
        ptyExitHandlerCountForTests: noPty,
        subscribePty: noPty,
        unsubscribePty: noPty,
        unsubscribeAllPty: noPty,
        writePty: noPty,
        resizePty: noPty,
        reinitTmuxSession: noPty,
      },
    });
    const fixture = await createNativeProofFixture(t, root);
    await import('../methods/run.js');
    const { createRun, updateRun, persistRunNow } = await import('../runs/store.js');
    const { buildInteractiveRefinementRunnerCommand } =
      await import('../runners/launch-command.js');
    const { getRunnerObservability, sendRunnerInstructionWithOutcome } =
      await import('../runners/registry.js');
    const { reviewWorkspaceRunnerVars } = await import('../runners/review-startup.js');
    const { probeRunnerDescendantPid } = await import('../runners/session-process.js');
    const { shellQuote } = await import('../core/tmux.js');
    const { captureRunnerPromptAcceptanceBaseline } = await import('../runners/registry.js');
    const initial = createRun({
      flowType: 'dev',
      project: 'proof',
      ticketOrPr: 'Terminal submission proof',
      mode: 'validation',
    });
    const checkoutPath = path.join(root, 'projects/proof/repo');
    const promptPath = path.join(root, 'initial-prompt.txt');
    await writeFile(promptPath, 'Reply only READY. Do not use tools.');
    const command = buildInteractiveRefinementRunnerCommand({
      runner: 'codex',
      repo: checkoutPath,
      promptPath,
      workspaceTrust: 'trusted',
      skipUpdateCheck: true,
      disableHooks: true,
      modelQuestions: 'off',
      safetyTier: 'sandboxed',
    });
    assert.ok(command);
    const run = updateRun(initial.id, {
      status: 'reviewing',
      transport: 'tmux',
      metrics: { ...initial.metrics, runner: 'codex' },
      reviewWorkspace: {
        workspaceId,
        machine: 'submission-proof',
        executionNodeId: 'local',
        checkoutPath,
        taskPath: path.join(root, 'projects/proof/task'),
        artifactPath: path.join(root, 'projects/proof/artifacts'),
      },
      agentContexts: [
        {
          id: 'review',
          role: 'review',
          label: 'Proof',
          runId: initial.id,
          slotId: null,
          runner: 'codex',
          status: 'working',
          target: { session, target: session },
        },
      ],
    });
    await persistRunNow(run);
    tmux('new-session', '-d', '-s', session, '-c', checkoutPath, 'bash');
    started = true;
    tmux('set-option', '-t', session, '@farmslot-review-workspace', workspaceId);
    tmux('set-option', '-w', '-t', session, 'remain-on-exit', 'on');
    // tmux automatically continues a stopped pane leader. A waiting parent shell lets
    // the negative control stop the actual runner descendants without that recovery.
    tmux(
      'respawn-pane',
      '-k',
      '-t',
      session,
      `bash -c ${shellQuote(command + '\nrunner_status=$?\nexit "$runner_status"')}`,
    );
    const vars = await reviewWorkspaceRunnerVars(run);
    const observability = getRunnerObservability('codex');
    assert.ok(
      vars &&
        observability?.getSessionBinding &&
        observability.promptAcceptedInSession &&
        observability.getTurnState,
    );
    const waitIdle = async () => {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        if (tmux('display-message', '-p', '-t', session, '#{pane_dead}') === '1')
          throw new Error('The owned Codex exited; see terminal-diagnostic.txt');
        const binding = await observability.getSessionBinding!(vars, session);
        const state = binding ? await observability.getTurnState!(vars, session) : null;
        if (binding && state?.value === 'idle' && state.confidence === 'high') return binding;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('The owned Codex terminal did not report native idle');
    };
    const binding = await waitIdle();
    const receipts: Array<Record<string, unknown>> = [];
    if (!negativeOnly) {
      const longText =
        'Reply only ACK_TERMINAL. Do not use tools.\n' +
        'This is a delivery verification line.\n'.repeat(45);
      const since = await captureRunnerPromptAcceptanceBaseline(vars, session, 'codex');
      assert.ok(since !== null);
      const result = await fixture.client.call<{ sent: boolean }>(Methods.TERMINAL_SEND, {
        slotId: '',
        runId: run.id,
        text: longText,
        enter: true,
      });
      assert.equal(result.sent, true);
      const accepted = await observability.promptAcceptedInSession(
        vars,
        session,
        binding.sessionId,
        binding.sessionPath,
        longText,
        since,
      );
      assert.ok(accepted?.value === true);
      assert.equal(accepted.exactPromptMatch, true);
      receipts.push({
        path: 'terminal.send/workspace',
        bytes: Buffer.byteLength(longText),
        result,
        source: accepted.source,
        turn: accepted.turnToken,
      });
      await writeFile(path.join(output, 'receipts.json'), JSON.stringify(receipts, null, 2) + '\n');
      await waitIdle();
      const farmText =
        'Reply only ACK_FARM. Do not use tools.\n' +
        'This is a retained farm instruction verification.\n'.repeat(40);
      const outcome = await sendRunnerInstructionWithOutcome(
        vars,
        session,
        'codex',
        farmText,
        'submission-proof',
        10_000,
      );
      assert.equal(outcome, 'sent');
      receipts.push({ path: 'farm instruction', bytes: Buffer.byteLength(farmText), outcome });
      await waitIdle();
    }
    const panePid = tmux('display-message', '-p', '-t', session, '#{pane_pid}');
    const processReading = await probeRunnerDescendantPid(vars, panePid, 'codex', {
      foregroundOnly: true,
    });
    assert.equal(processReading.state, 'present');
    assert.ok(processReading.pid);
    const processRows = () =>
      execFileSync('ps', ['-axo', 'pid=,ppid=,state=,comm='], { encoding: 'utf8' })
        .trim()
        .split('\n')
        .map((line) => {
          const [pid, parent, state, ...command] = line.trim().split(/\s+/);
          return { pid: Number(pid), parent: Number(parent), state, command: command.join(' ') };
        });
    const owned = new Set([Number(panePid)]);
    const rows = processRows();
    let added = true;
    while (added) {
      added = false;
      for (const row of rows)
        if (owned.has(row.parent) && !owned.has(row.pid)) {
          owned.add(row.pid);
          added = true;
        }
    }
    assert.ok(owned.has(Number(processReading.pid)) && !owned.has(process.pid));
    assert.notEqual(Number(processReading.pid), Number(panePid));
    const ownedRows = rows.filter((row) => owned.has(row.pid) && row.pid !== Number(panePid));
    await writeFile(
      path.join(output, 'owned-processes.json'),
      JSON.stringify(ownedRows, null, 2) + '\n',
    );
    // Stop every descendant, not just a CLI launcher that may have a separate child group.
    for (const row of [...ownedRows].reverse()) {
      process.kill(row.pid, 'SIGSTOP');
      pausedPids.push(row.pid);
    }
    const stopDeadline = Date.now() + 3000;
    const pausing = new Set(ownedRows.map((row) => row.pid));
    let stopped = processRows().filter((row) => pausing.has(row.pid));
    while (Date.now() < stopDeadline && !stopped.every((row) => row.state?.startsWith('T'))) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      stopped = processRows().filter((row) => pausing.has(row.pid));
    }
    await writeFile(
      path.join(output, 'stopped-processes.json'),
      JSON.stringify(stopped, null, 2) + '\n',
    );
    assert.equal(stopped.length, pausing.size);
    assert.ok(
      stopped.every((row) => row.state?.startsWith('T')),
      'Every owned terminal process must actually stop',
    );
    const since = await captureRunnerPromptAcceptanceBaseline(vars, session, 'codex');
    assert.ok(since !== null);
    const unsubmitted =
      'Reply only AFTER_RESUME. Do not use tools.\n' +
      'The stopped terminal cannot accept this prompt.\n'.repeat(40);
    await assert.rejects(
      fixture.client.call(Methods.TERMINAL_SEND, {
        slotId: '',
        runId: run.id,
        text: unsubmitted,
        enter: true,
      }),
      /submission.*not confirmed|input refused/i,
    );
    const missing = await observability.promptAcceptedInSession(
      vars,
      session,
      binding.sessionId,
      binding.sessionPath,
      unsubmitted,
      since,
    );
    assert.notEqual(missing?.value, true);
    receipts.push({
      path: 'terminal.send/unsubmitted',
      bytes: Buffer.byteLength(unsubmitted),
      rejected: true,
      nativeAccepted: false,
    });
    await writeFile(
      path.join(output, 'proof.json'),
      JSON.stringify(
        {
          status: 'pass',
          target: 'isolated',
          codexVersion: execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim(),
          farmDispatches: 0,
          receipts,
        },
        null,
        2,
      ) + '\n',
    );
  },
);
