import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { writeEvidence } from '../lib/evidence.mjs';

export const SCENARIO_ID = 'copilot-runtime-smoke';

function rpc(method, params = {}) {
  const script = path.resolve('apps/command-center/scripts/cdp.mjs');
  const stdout = execFileSync('node', [script, 'gateway', method, JSON.stringify(params)], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FARMSLOT_RPC_TIMEOUT_MS: process.env.FARMSLOT_RPC_TIMEOUT_MS ?? '60000',
    },
  });
  return JSON.parse(stdout);
}

async function waitForHistory(token, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const history = rpc('chat.history', { sessionId: 'global' });
    if (history.messages.some((message) => message.content.includes(token))) return history;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${token} in shared Co-Pilot history`);
}

async function waitForIdle(session, sinceMs, timeoutMs) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        path.resolve('scripts/runner-validation/gateway/copilot-idle.mts'),
        JSON.stringify({
          checkout: session.checkout.path,
          runner: session.runner,
          target: session.tmuxTarget,
          sinceMs,
          timeoutMs,
        }),
      ],
      { encoding: 'utf8', env: process.env, timeout: timeoutMs + 10000 },
    ),
  );
}

export async function runScenario({
  runnerAdapter,
  timeoutMs,
  outDir,
  via,
  resumeExisting = false,
}) {
  const runner = runnerAdapter.RUNNER_ID;
  const marker = randomUUID();
  const clientToken = `COPILOT_COMMAND_CENTER_PROOF_${marker}`;
  const directToken = `COPILOT_DIRECT_TMUX_PROOF_${marker}`;
  const report = {
    runner,
    start: null,
    send: null,
    directTmuxMessages: 0,
    reconnect: null,
    isolation: null,
    stop: null,
    pass: false,
    error: null,
  };
  try {
    if (resumeExisting) assert.equal(via, 'model-effort');
    if (via === 'model-effort') {
      assert.equal(process.env.FARMSLOT_GATEWAY, 'ws://127.0.0.1:18777');
      assert.ok(
        process.env.TMUX_TMPDIR?.startsWith('/tmp/fs-'),
        'Use the private validation tmux server',
      );
      assert.equal(
        rpc('copilot.status').session.status,
        resumeExisting ? 'running' : 'stopped',
        'Start with an idle private Copilot',
      );
    }
    const before = rpc('operator.snapshot');
    if (!resumeExisting)
      try {
        rpc('copilot.stop', { reason: 'runner-validation-reset' });
      } catch (error) {
        if (!String(error).includes('METHOD_NOT_FOUND')) throw error;
      }
    if (via === 'model-effort' && !resumeExisting) {
      assert.equal(runner, 'codex');
      report.configured = rpc('copilot.configure', { runner, model: 'gpt-6-astra', effort: 'low' });
    }
    report.start = rpc(
      'copilot.start',
      resumeExisting ? { mode: 'reconnect' } : { runner, safetyTier: 'sandboxed' },
    );
    const startedAt = Date.parse(report.start.session.startedAt);
    assert.ok(Number.isFinite(startedAt));
    report.bootstrapIdle = await waitForIdle(report.start.session, startedAt, timeoutMs);
    if (via === 'model-effort') {
      assert.equal(report.start.session.model, 'gpt-6-astra');
      assert.equal(report.start.session.effort, 'low');
      const panePid = Number(
        execFileSync(
          'tmux',
          ['display-message', '-p', '-t', report.start.session.tmuxTarget, '#{pane_pid}'],
          { encoding: 'utf8' },
        ).trim(),
      );
      const census = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
        .trim()
        .split('\n')
        .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
        .filter(Boolean)
        .map((match) => ({ pid: Number(match[1]), parent: Number(match[2]), command: match[3] }));
      const owned = new Set([panePid]);
      for (let added = true; added; ) {
        added = false;
        for (const process of census)
          if (owned.has(process.parent) && !owned.has(process.pid)) {
            owned.add(process.pid);
            added = true;
          }
      }
      const worker = census.find(
        (process) =>
          owned.has(process.pid) &&
          /(?:^|\/)codex(?:\s|$)/.test(process.command) &&
          process.command.includes('--model gpt-6-astra') &&
          /model_reasoning_effort=["']?low/.test(process.command),
      );
      assert.ok(worker, 'Owned runner argv must carry Astra and low reasoning effort');
      report.launchIdentity = { pid: worker.pid, panePid, model: 'gpt-6-astra', effort: 'low' };
      assert.throws(
        () => rpc('copilot.configure', { effort: 'medium' }),
        /Stop the Co-Pilot runtime/,
      );
      const reconnected = rpc('copilot.start', {
        mode: 'reconnect',
        model: 'gpt-5.6-sol',
        effort: 'medium',
      });
      assert.equal(reconnected.reused, true);
      assert.equal(reconnected.session.model, 'gpt-6-astra');
      assert.equal(reconnected.session.effort, 'low');
      assert.deepEqual(reconnected.session.terminalWorker, report.start.session.terminalWorker);
    }
    const sentAt = Date.now();
    report.send = rpc('chat.send', {
      sessionId: 'global',
      message: `Acknowledge ${clientToken} once.`,
    });
    if (report.send.delivery?.state !== 'accepted')
      throw new Error('Client prompt lacks an exact delivery acknowledgement');
    await waitForHistory(clientToken, timeoutMs);
    report.clientIdle = await waitForIdle(report.start.session, sentAt, timeoutMs);

    execFileSync('tmux', [
      'send-keys',
      '-t',
      'farmslot-copilot:agent.0',
      '-l',
      `Acknowledge ${directToken} once.`,
    ]);
    execFileSync('tmux', ['send-keys', '-t', 'farmslot-copilot:agent.0', 'Enter']);
    const shared = await waitForHistory(directToken, timeoutMs);
    report.directTmuxMessages = shared.messages.filter((message) =>
      message.content.includes(directToken),
    ).length;

    report.reconnect = rpc('copilot.start', { mode: 'reconnect' });
    report.stop = rpc('copilot.stop', { reason: 'runner-validation-complete' });
    const after = rpc('operator.snapshot');
    report.isolation = {
      totalSlots: [before.counts.totalSlots, after.counts.totalSlots],
      activeRuns: [before.counts.activeRuns, after.counts.activeRuns],
      queuedItems: [before.counts.queuedItems, after.counts.queuedItems],
    };
    report.pass =
      report.start.session.status === 'running' &&
      report.send.delivery?.state === 'accepted' &&
      report.directTmuxMessages === 1 &&
      report.reconnect.reused === true &&
      report.reconnect.session.runtimeId === report.start.session.runtimeId &&
      report.stop.session.status === 'stopped' &&
      report.isolation.totalSlots[0] === report.isolation.totalSlots[1] &&
      report.isolation.activeRuns[0] === report.isolation.activeRuns[1] &&
      report.isolation.queuedItems[0] === report.isolation.queuedItems[1];
  } catch (error) {
    report.error = error?.message || String(error);
  }
  const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
  return { scenario: SCENARIO_ID, runner, outPath, pass: report.pass, report };
}
