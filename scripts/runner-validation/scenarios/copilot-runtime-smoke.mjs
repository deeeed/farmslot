import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { writeEvidence } from '../lib/evidence.mjs';

export const SCENARIO_ID = 'copilot-runtime-smoke';

function rpc(method, params = {}) {
  const script = path.resolve('apps/command-center/scripts/cdp.mjs');
  const stdout = execFileSync('node', [script, 'gateway', method, JSON.stringify(params)], {
    encoding: 'utf8',
    env: process.env,
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

export async function runScenario({ runnerAdapter, timeoutMs, outDir }) {
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
    const before = rpc('operator.snapshot');
    try {
      rpc('copilot.stop', { reason: 'runner-validation-reset' });
    } catch (error) {
      if (!String(error).includes('METHOD_NOT_FOUND')) throw error;
    }
    const startedAt = Date.now();
    report.start = rpc('copilot.start', { runner, safetyTier: 'sandboxed' });
    report.bootstrapIdle = await waitForIdle(report.start.session, startedAt, timeoutMs);
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
