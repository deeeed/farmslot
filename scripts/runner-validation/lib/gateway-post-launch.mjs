import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ROOT } from './common.mjs';

/**
 * Invoke gateway sendRunnerPostLaunchPrompt against a local tmux target.
 * Same code path as dispatch/execute.ts post-launch task delivery.
 */
export function runGatewayPostLaunchPrompt({
  repo,
  target,
  runner,
  message,
  marker,
  timeoutMs = 120_000,
  artifactsDir,
  requirePromptDigest = false,
}) {
  fs.mkdirSync(artifactsDir, { recursive: true });
  const blockerSnapshotPath = `${artifactsDir}/dispatch-launch.txt`;

  const snippet = `
import os from 'node:os';
import { sendRunnerPostLaunchPrompt } from './services/gateway/src/runners/registry.ts';

const vars = {
  slotId: 'runner-validate-local',
  machine: os.hostname(),
  platform: 'local',
  host: 'localhost',
  sshUser: os.userInfo().username,
  osType: process.platform === 'darwin' ? 'darwin' : 'linux',
  claudePath: '',
  codexPath: '',
  opencodePath: '',
  cursorPath: '',
  grokPath: '',
  dispatchCmd: '',
  recycleCmd: '',
  repo: ${JSON.stringify(repo)},
  session: ${JSON.stringify(target)},
  slotMode: 'dispatch',
  slotEnabled: true,
  sshTarget: \`\${os.userInfo().username}@localhost\`,
  remoteRepo: ${JSON.stringify(repo)},
  projectName: '',
  resourceVars: {},
};

try {
  await sendRunnerPostLaunchPrompt(
    vars,
    ${JSON.stringify(target)},
    ${JSON.stringify(runner)},
    ${JSON.stringify(message)},
    ${JSON.stringify(marker)},
    'dispatch-prompt-smoke',
    {
      readyTimeoutMs: ${timeoutMs},
      blockerSnapshotPath: ${JSON.stringify(blockerSnapshotPath)},
      softAcceptOnHandoffAck: true,
      handoffAckSinceMs: Date.now(),
      requirePromptDigest: ${requirePromptDigest},
    },
  );
  console.log(JSON.stringify({ ok: true, blockerSnapshotPath: ${JSON.stringify(blockerSnapshotPath)} }));
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    error: error?.message || String(error),
    blockerSnapshotPath: ${JSON.stringify(blockerSnapshotPath)},
  }));
  process.exit(1);
}

`;

  const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', snippet], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs + 90_000,
    env: {
      ...process.env,
      FARMSLOT_HOME: process.env.FARMSLOT_HOME ?? `${os.homedir()}/.farmslot-dev`,
    },
  });

  const stdout = result.stdout?.trim() ?? '';
  const jsonLine = stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .pop();
  if (!jsonLine) {
    return {
      ok: false,
      error: result.stderr?.trim() || stdout || 'gateway post-launch prompt failed',
      blockerSnapshotPath,
      exitCode: result.status,
    };
  }

  const parsed = JSON.parse(jsonLine);
  return {
    ...parsed,
    gatewayLog:
      stdout
        .split('\n')
        .filter((line) => line && line !== jsonLine)
        .join('\n') || null,
    exitCode: result.status,
    stderr: result.stderr?.trim() || null,
  };
}

/** Exercise the production argv-relaunch handoff and task-signal acknowledgement. */
export function runGatewayArgvRelaunch({
  repo,
  target,
  runner,
  runnerPath,
  model,
  prompt,
  replacementReadySignalPath,
  signalPath,
  timeoutMs = 120_000,
}) {
  const snippet = `
import os from 'node:os';
import { deliverPromptToLiveRunner } from './services/gateway/src/runners/session-reactivation.ts';

const vars = {
  slotId: 'runner-validate-local',
  machine: os.hostname(),
  platform: 'local',
  host: 'localhost',
  sshUser: os.userInfo().username,
  osType: process.platform === 'darwin' ? 'darwin' : 'linux',
  claudePath: '',
  codexPath: '',
  opencodePath: '',
  cursorPath: ${JSON.stringify(runnerPath)},
  grokPath: '',
  dispatchCmd: '',
  recycleCmd: '',
  repo: ${JSON.stringify(repo)},
  session: ${JSON.stringify(target)},
  slotMode: 'dispatch',
  slotEnabled: true,
  sshTarget: \`\${os.userInfo().username}@localhost\`,
  remoteRepo: ${JSON.stringify(repo)},
  projectName: '',
  resourceVars: {},
};

const result = await deliverPromptToLiveRunner({
  vars,
  target: ${JSON.stringify(target)},
  runnerId: ${JSON.stringify(runner)},
  model: ${JSON.stringify(model)},
  prompt: ${JSON.stringify(prompt)},
  promptMarker: 'ARGV-RELAUNCH',
  replacementReadySignalPath: ${JSON.stringify(replacementReadySignalPath)},
  launchAckSignalPath: ${JSON.stringify(signalPath)},
  timeoutMs: ${timeoutMs},
  safetyTier: 'full-auto',
});
console.log(JSON.stringify(result));
if (!result.delivered) process.exit(1);
`;

  const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', snippet], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs + 30_000,
    env: {
      ...process.env,
      FARMSLOT_HOME: process.env.FARMSLOT_HOME ?? `${os.homedir()}/.farmslot-dev`,
    },
  });
  const stdout = result.stdout?.trim() ?? '';
  const jsonLine = stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .pop();
  return {
    result: jsonLine ? JSON.parse(jsonLine) : null,
    stdout,
    stderr: result.stderr?.trim() || null,
    exitCode: result.status,
  };
}

/** Read the production runner-native turn state for an exact tmux pane. */
export function runGatewayTurnState({ repo, target, runner, timeoutMs = 30_000 }) {
  const snippet = `
import os from 'node:os';
import { readRunnerTurnState } from './services/gateway/src/runners/registry.ts';
const vars = {
  slotId: 'runner-validate-local', machine: os.hostname(), platform: 'local', host: 'localhost',
  sshUser: os.userInfo().username, osType: process.platform === 'darwin' ? 'darwin' : 'linux',
  claudePath: '', codexPath: '', opencodePath: '', cursorPath: '', grokPath: '',
  dispatchCmd: '', recycleCmd: '', repo: ${JSON.stringify(repo)}, session: ${JSON.stringify(target)},
  slotMode: 'dispatch', slotEnabled: true, sshTarget: \`\${os.userInfo().username}@localhost\`,
  remoteRepo: ${JSON.stringify(repo)}, projectName: '', resourceVars: {},
};
const state = await readRunnerTurnState(vars, ${JSON.stringify(target)}, ${JSON.stringify(runner)});
process.stdout.write(JSON.stringify({ state }) + '\\n');
`;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', snippet], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  const jsonLine = (result.stdout?.trim() ?? '')
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .pop();
  return jsonLine ? JSON.parse(jsonLine).state : null;
}

/** Exercise the production session-attribution contract for one live runner pane. */
export function runGatewaySessionBinding({
  repo,
  target,
  runner,
  beforePaths,
  sinceMs,
  slotId,
  timeoutMs = 30_000,
}) {
  const snippet = `
import os from 'node:os';
import { resolveRunnerSessionBinding } from './services/gateway/src/runners/session-process.ts';

const vars = {
  slotId: ${JSON.stringify(slotId)},
  machine: os.hostname(),
  platform: 'local',
  host: 'localhost',
  sshUser: os.userInfo().username,
  osType: process.platform === 'darwin' ? 'darwin' : 'linux',
  claudePath: '',
  codexPath: '',
  opencodePath: '',
  cursorPath: '',
  grokPath: '',
  dispatchCmd: '',
  recycleCmd: '',
  repo: ${JSON.stringify(repo)},
  session: ${JSON.stringify(target)},
  slotMode: 'dispatch',
  slotEnabled: true,
  sshTarget: \`\${os.userInfo().username}@localhost\`,
  remoteRepo: ${JSON.stringify(repo)},
  projectName: '',
  resourceVars: {},
};

const binding = await resolveRunnerSessionBinding(
  vars,
  ${JSON.stringify(runner)},
  ${JSON.stringify(beforePaths)},
  {
    sinceMs: ${JSON.stringify(sinceMs)},
    paneId: ${JSON.stringify(target)},
    slotId: ${JSON.stringify(slotId)},
  },
);
process.stdout.write(JSON.stringify({ binding }) + '\\n');
`;

  const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', snippet], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: {
      ...process.env,
      FARMSLOT_HOME: process.env.FARMSLOT_HOME ?? `${os.homedir()}/.farmslot-dev`,
    },
  });
  const stdout = result.stdout?.trim() ?? '';
  const jsonLine = stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .pop();
  return {
    binding: jsonLine ? JSON.parse(jsonLine).binding : null,
    exitCode: result.status,
    error:
      result.stderr?.trim() || (!jsonLine ? stdout || 'binding wrapper returned no result' : null),
  };
}

/** Read the exact live runner-process boundary used by session attribution. */
export function runGatewayPaneProcessStartedAt({ repo, target, runner, timeoutMs = 30_000 }) {
  const snippet = `
import os from 'node:os';
import { readPaneProcessStartedAtMs } from './services/gateway/src/runners/session-process.ts';

const vars = {
  slotId: 'runner-validate-local', machine: os.hostname(), platform: 'local', host: 'localhost',
  sshUser: os.userInfo().username, osType: process.platform === 'darwin' ? 'darwin' : 'linux',
  claudePath: '', codexPath: '', opencodePath: '', cursorPath: '', grokPath: '',
  dispatchCmd: '', recycleCmd: '', repo: ${JSON.stringify(repo)}, session: ${JSON.stringify(target)},
  slotMode: 'dispatch', slotEnabled: true, sshTarget: \`\${os.userInfo().username}@localhost\`,
  remoteRepo: ${JSON.stringify(repo)}, projectName: '', resourceVars: {},
};
const startedAtMs = await readPaneProcessStartedAtMs(
  vars,
  ${JSON.stringify(target)},
  ${JSON.stringify(runner)},
);
process.stdout.write(JSON.stringify({ startedAtMs }) + '\\n');
`;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', snippet], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  const jsonLine = (result.stdout?.trim() ?? '')
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .pop();
  return jsonLine ? JSON.parse(jsonLine).startedAtMs : null;
}

/** Invoke the production safe-send contract against an already-idle runner pane. */
export function runGatewaySafeInstruction({
  repo,
  target,
  runner,
  message,
  sessionId,
  sessionPath,
  timeoutMs = 30_000,
}) {
  const snippet = `
import os from 'node:os';
import { sendCiFixNudge } from './services/gateway/src/ci-monitor/inline-fix.ts';

const vars = {
  slotId: 'runner-validate-local',
  machine: os.hostname(),
  platform: 'local',
  host: 'localhost',
  sshUser: os.userInfo().username,
  osType: process.platform === 'darwin' ? 'darwin' : 'linux',
  claudePath: '',
  codexPath: '',
  opencodePath: '',
  cursorPath: '',
  grokPath: '',
  dispatchCmd: '',
  recycleCmd: '',
  repo: ${JSON.stringify(repo)},
  session: ${JSON.stringify(target)},
  slotMode: 'dispatch',
  slotEnabled: true,
  sshTarget: \`\${os.userInfo().username}@localhost\`,
  remoteRepo: ${JSON.stringify(repo)},
  projectName: '',
  resourceVars: {},
};

const run = {
  id: 'runner-validate-ci-fix',
  flowType: 'dev',
  metrics: {
    runner: ${JSON.stringify(runner)},
    model: null,
    nudgeCount: 0,
    runnerSessionId: ${JSON.stringify(sessionId)},
    runnerSessionPath: ${JSON.stringify(sessionPath)},
  },
  agentContexts: [{
    role: 'dev',
    runnerSessionId: ${JSON.stringify(sessionId)},
    runnerSessionPath: ${JSON.stringify(sessionPath)},
  }],
};

const delivery = await sendCiFixNudge({
  vars,
  target: ${JSON.stringify(target)},
  runner: ${JSON.stringify(runner)},
  prompt: ${JSON.stringify(message)},
  run,
  timeoutMs: ${timeoutMs},
  forceBusyPoll: true,
});
const delivered = delivery.sent;
process.stdout.write(JSON.stringify({ delivered }) + '\\n', () => {
  process.exit(delivered ? 0 : 1);
});
`;

  const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', snippet], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs + 30_000,
    env: {
      ...process.env,
      FARMSLOT_HOME: process.env.FARMSLOT_HOME ?? `${os.homedir()}/.farmslot-dev`,
    },
  });
  const stdout = result.stdout?.trim() ?? '';
  const jsonLine = stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .pop();
  return {
    result: jsonLine ? JSON.parse(jsonLine) : null,
    exitCode: result.status,
    error:
      result.stderr?.trim() ||
      (!jsonLine ? stdout || 'safe-send wrapper returned no result' : null),
  };
}

/**
 * Exercise the production monitor budget tick against a real retained runner.
 * The isolated pool/run store prevents validation state from touching a live farm.
 */
export function runGatewayBudgetGuard({
  repo,
  slotId,
  session,
  target,
  runner,
  sessionId,
  sessionPath,
  timeoutMs = 60_000,
  // Keep the harness so a second phase can re-poll the same warm run after the live
  // runner has actually appended a turn. Caller owns cleanup when set.
  keepHarness = false,
}) {
  const harnessRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-validate-budget-'));
  const poolDir = path.join(harnessRoot, 'pool');
  const farmslotHome = path.join(harnessRoot, 'home');
  const runsDir = path.join(harnessRoot, 'runs');
  fs.mkdirSync(poolDir, { recursive: true });
  fs.mkdirSync(farmslotHome, { recursive: true });
  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(
    path.join(poolDir, 'local.json'),
    JSON.stringify({
      schema_version: 1,
      machine: os.hostname().replace(/\.local$/, ''),
      project: 'runner-validation',
      platform: 'local',
      os: process.platform === 'darwin' ? 'darwin' : 'linux',
      host: 'localhost',
      ssh_user: os.userInfo().username,
      slots: [
        {
          id: slotId,
          enabled: true,
          repo,
          session,
          runner,
          resources: {},
        },
      ],
    }),
  );

  const snippet = `
import { agentRoleLabel, contextIdFor, Events, primaryRoleForFlow } from '@farmslot/protocol';
import {
  initRunMonitor,
  pollRunBudgetGuard,
  prepareWarmBudgetBaselineForHandoff,
} from './services/gateway/src/run-engine/run-monitor.ts';
import { createRun, getRun, updateRun } from './services/gateway/src/runs/store.ts';

const run = createRun({
  flowType: 'update-branch',
  project: 'runner-validation',
  ticketOrPr: 'runner-validation-budget-guard',
  slotId: ${JSON.stringify(slotId)},
  runner: ${JSON.stringify(runner)},
  branch: 'runner-validation',
});
const role = primaryRoleForFlow(run.flowType);
const now = new Date().toISOString();
updateRun(run.id, {
  status: 'monitoring',
  metrics: {
    ...run.metrics,
    runner: ${JSON.stringify(runner)},
  },
  agentContexts: [{
    id: contextIdFor(role),
    role,
    label: agentRoleLabel(role),
    status: 'idle',
    slotId: ${JSON.stringify(slotId)},
    runId: run.id,
    runner: ${JSON.stringify(runner)},
    target: {
      session: ${JSON.stringify(session)},
      pane: ${JSON.stringify(target)},
      target: ${JSON.stringify(target)},
    },
    runnerSessionId: ${JSON.stringify(sessionId)},
    runnerSessionPath: ${JSON.stringify(sessionPath)},
    startedAt: now,
    updatedAt: now,
  }],
});

const events = [];
initRunMonitor((event, payload) => events.push({ event, payload }));
const first = await pollRunBudgetGuard({
  runId: run.id,
  slotId: ${JSON.stringify(slotId)},
  maxTurns: 1,
  maxTotalTokens: 1,
  agentStatus: 'idle',
  sendNudge: true,
});
const afterFirst = getRun(run.id);
const second = await pollRunBudgetGuard({
  runId: run.id,
  slotId: ${JSON.stringify(slotId)},
  maxTurns: 1,
  maxTotalTokens: 1,
  agentStatus: 'working',
  sendNudge: true,
});
const afterSecond = getRun(run.id);
const unsupportedRun = createRun({
  flowType: 'update-branch',
  project: 'runner-validation',
  ticketOrPr: 'runner-validation-unsupported-warm-budget',
  slotId: ${JSON.stringify(slotId)},
  runner: 'grok',
  branch: 'runner-validation',
});
const unsupportedWarmBaseline = await prepareWarmBudgetBaselineForHandoff(
  unsupportedRun.id,
  ${JSON.stringify(slotId)},
);

// Warm handoff onto the live transcript: the child must inherit a byte pin, not the
// parent's counted usage, so its ceiling applies only to what it appends.
const warmRun = createRun({
  flowType: 'update-branch',
  project: 'runner-validation',
  ticketOrPr: 'runner-validation-warm-budget-baseline',
  slotId: ${JSON.stringify(slotId)},
  runner: ${JSON.stringify(runner)},
  branch: 'runner-validation',
});
updateRun(warmRun.id, {
  metrics: {
    ...warmRun.metrics,
    runner: ${JSON.stringify(runner)},
    runnerSessionPath: ${JSON.stringify(sessionPath)},
  },
});
const warmBaseline = await prepareWarmBudgetBaselineForHandoff(
  warmRun.id,
  ${JSON.stringify(slotId)},
);
const warmUsage = getRun(warmRun.id)?.monitorState?.budgetUsage ?? null;
// Ceilings of 1 would breach instantly on any inherited history.
const warmTick = await pollRunBudgetGuard({
  runId: warmRun.id,
  slotId: ${JSON.stringify(slotId)},
  maxTurns: 1,
  maxTotalTokens: 1,
  agentStatus: 'idle',
  sendNudge: false,
});

// A runner with no session-usage provider can never be measured. The guard must
// record the gap without typing an accusation into the live worker pane.
const unmeasuredRun = createRun({
  flowType: 'update-branch',
  project: 'runner-validation',
  ticketOrPr: 'runner-validation-unmeasured-runner-budget',
  slotId: ${JSON.stringify(slotId)},
  runner: 'cursor',
  branch: 'runner-validation',
});
const unmeasuredRole = primaryRoleForFlow(unmeasuredRun.flowType);
updateRun(unmeasuredRun.id, {
  status: 'monitoring',
  metrics: { ...unmeasuredRun.metrics, runner: 'cursor' },
  agentContexts: [{
    id: contextIdFor(unmeasuredRole),
    role: unmeasuredRole,
    label: agentRoleLabel(unmeasuredRole),
    status: 'idle',
    slotId: ${JSON.stringify(slotId)},
    runId: unmeasuredRun.id,
    runner: 'cursor',
    target: {
      session: ${JSON.stringify(session)},
      pane: ${JSON.stringify(target)},
      target: ${JSON.stringify(target)},
    },
    startedAt: now,
    updatedAt: now,
  }],
});
const unmeasuredTick = await pollRunBudgetGuard({
  runId: unmeasuredRun.id,
  slotId: ${JSON.stringify(slotId)},
  maxTurns: 1,
  maxTotalTokens: 1,
  agentStatus: 'working',
  sendNudge: true,
});
process.stdout.write(JSON.stringify({
  first: {
    budgetWarned: first.budgetWarned,
    violationType: first.violation?.type ?? null,
    nudgeSent: first.nudgeSent,
    sampleTurns: first.sampleTurns,
    sampleTotalTokens: first.sampleTotalTokens,
  },
  second: {
    budgetWarned: second.budgetWarned,
    violationType: second.violation?.type ?? null,
    nudgeSent: second.nudgeSent,
  },
  persistedAfterFirst: {
    budgetWarned: afterFirst?.monitorState?.budgetWarned === true,
    budgetNudgeSent: afterFirst?.monitorState?.budgetNudgeSent === true,
    budgetNudgeAttempts: afterFirst?.monitorState?.budgetNudgeAttempts ?? null,
  },
  persistedAfterSecond: {
    budgetWarned: afterSecond?.monitorState?.budgetWarned === true,
    budgetNudgeSent: afterSecond?.monitorState?.budgetNudgeSent === true,
    budgetNudgeAttempts: afterSecond?.monitorState?.budgetNudgeAttempts ?? null,
  },
  unsupportedWarmBaseline,
  warmRunId: warmRun.id,
  warmBaseline: {
    status: warmBaseline,
    // The pin must sit on a record boundary at or before EOF, never inside a
    // half-written record (which would fail accounting closed as malformed JSONL).
    pinnedAtRecordBoundary: warmUsage
      ? warmUsage.offset > 0 && warmUsage.offset <= warmUsage.size
      : false,
    pinnedOffset: warmUsage?.offset ?? null,
    transcriptSize: warmUsage?.size ?? null,
    baselineTurns: warmUsage?.baselineTurns ?? null,
    baselineTotalTokens: warmUsage?.baselineTotalTokens ?? null,
    breachedOnInheritedHistory: warmTick.budgetWarned === true,
  },
  unmeasuredRunner: {
    unsupportedRunner: unmeasuredTick.unsupportedRunner,
    violationType: unmeasuredTick.violation?.type ?? null,
    violationMessage: unmeasuredTick.violation?.message ?? null,
    nudgeSent: unmeasuredTick.nudgeSent,
    budgetNudgeAttempts: unmeasuredTick.budgetNudgeAttempts,
  },
  violationEvents: events.filter((entry) => entry.event === Events.MONITOR_VIOLATION).length,
}) + '\\n');
`;

  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', snippet], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: timeoutMs,
      env: {
        ...process.env,
        FARMSLOT_HOME: farmslotHome,
        FARMSLOT_POOL_DIR: poolDir,
        FARMSLOT_RUNS_DIR: runsDir,
      },
    });
    const stdout = result.stdout?.trim() ?? '';
    const jsonLine = stdout
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .pop();
    return {
      result: jsonLine ? JSON.parse(jsonLine) : null,
      exitCode: result.status,
      error:
        result.status !== 0
          ? result.stderr?.trim() || stdout || 'budget-guard wrapper failed'
          : !jsonLine
            ? stdout || 'budget-guard wrapper returned no result'
            : null,
      stderr: result.stderr?.trim() || null,
      gatewayLog:
        stdout
          .split('\n')
          .filter((line) => line && line !== jsonLine)
          .join('\n') || null,
      harnessRoot,
    };
  } finally {
    if (!keepHarness) fs.rmSync(harnessRoot, { recursive: true, force: true });
  }
}

/**
 * Second phase of the warm-baseline proof: re-poll a warm run whose baseline was pinned
 * by runGatewayBudgetGuard, after the live runner has appended a real turn.
 *
 * Phase one alone cannot fail from the bug it guards — with nothing appended, the charge
 * is `total - baseline` with both sides equal, so it reads zero whether the baseline is
 * the parent's real cumulative total or zero. Only post-pin growth separates the two.
 */
export function runGatewayWarmBudgetCharge({ harnessRoot, runId, slotId, timeoutMs = 60_000 }) {
  const snippet = `
import { pollRunBudgetGuard } from './services/gateway/src/run-engine/run-monitor.ts';
import {
  emptyBudgetUsageSampleState,
  sampleBudgetUsage,
} from './services/gateway/src/run-engine/budget-usage-sample.ts';
import { loadSlotVars } from './services/gateway/src/core/config.ts';
import { getRun, loadAllRuns } from './services/gateway/src/runs/store.ts';

// Fresh process: hydrate the store from the harness runs dir phase one wrote.
await loadAllRuns();

// Ceilings high enough that this poll only measures; it must not warn.
const tick = await pollRunBudgetGuard({
  runId: ${JSON.stringify(runId)},
  slotId: ${JSON.stringify(slotId)},
  maxTurns: 100000,
  maxTotalTokens: 1000000000000,
  agentStatus: 'idle',
  sendNudge: false,
});
const run = getRun(${JSON.stringify(runId)});
const usage = run?.monitorState?.budgetUsage ?? null;
// Cold full scan of the same transcript: what this run would be charged with no pin.
const fullScan = await sampleBudgetUsage({
  slotId: ${JSON.stringify(slotId)},
  vars: await loadSlotVars(${JSON.stringify(slotId)}),
  runner: run?.metrics?.runner,
  runnerSessionPath: usage?.path ?? run?.metrics?.runnerSessionPath ?? null,
  prior: emptyBudgetUsageSampleState(),
});
process.stdout.write(JSON.stringify({
  fullScanTotalTokens: fullScan.totalTokens,
  fullScanTurns: fullScan.turns,
  sampleTurns: tick.sampleTurns,
  sampleTotalTokens: tick.sampleTotalTokens,
  chargeTurns: tick.chargeTurns,
  chargeTotalTokens: tick.chargeTotalTokens,
  baselineTotalTokens: usage?.baselineTotalTokens ?? null,
  availability: tick.availability,
  budgetWarned: tick.budgetWarned,
}) + '\\n');
`;

  const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', snippet], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: {
      ...process.env,
      FARMSLOT_HOME: path.join(harnessRoot, 'home'),
      FARMSLOT_POOL_DIR: path.join(harnessRoot, 'pool'),
      FARMSLOT_RUNS_DIR: path.join(harnessRoot, 'runs'),
    },
  });
  const stdout = result.stdout?.trim() ?? '';
  const jsonLine = stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .pop();
  return {
    result: jsonLine ? JSON.parse(jsonLine) : null,
    exitCode: result.status,
    error:
      result.status !== 0
        ? result.stderr?.trim() || stdout || 'warm-budget-charge wrapper failed'
        : !jsonLine
          ? stdout || 'warm-budget-charge wrapper returned no result'
          : null,
  };
}

/** Execute the production repeat-review resume path against a local runner session. */
export function runGatewayRepeatReviewResume({
  repo,
  target,
  runner,
  sessionId,
  sessionPath,
  prompt,
  runnerPath,
  model,
  slotId = 'runner-validate-local',
  currentSlotId = slotId,
  sessionIntent = 'resume',
  expectedKind = 'resumed',
  timeoutMs = 120_000,
}) {
  const snippet = `
import os from 'node:os';
import { attemptRepeatReviewResume, resolveRepeatReviewResumePlan } from './services/gateway/src/run-engine/review-session-chain.ts';

const vars = {
  slotId: ${JSON.stringify(slotId)},
  machine: os.hostname(),
  platform: 'local',
  host: 'localhost',
  sshUser: os.userInfo().username,
  osType: process.platform === 'darwin' ? 'darwin' : 'linux',
  claudePath: ${JSON.stringify(runner === 'claude' ? runnerPath : '')},
  codexPath: ${JSON.stringify(runner === 'codex' ? runnerPath : '')},
  opencodePath: '',
  cursorPath: '',
  grokPath: '',
  dispatchCmd: '',
  recycleCmd: '',
  repo: ${JSON.stringify(repo)},
  session: ${JSON.stringify(target)},
  slotMode: 'dispatch',
  slotEnabled: true,
  sshTarget: \`\${os.userInfo().username}@localhost\`,
  remoteRepo: ${JSON.stringify(repo)},
  projectName: '',
  resourceVars: {},
};

const current = {
  flowType: 'review-pr',
  project: 'farmslot-farm',
  slotId: ${JSON.stringify(currentSlotId)},
  repeatReviewContext: {
    version: 1,
    chainId: 'review-generation-1',
    generation: 2,
    priorRunId: 'review-generation-1',
    priorFamilyId: 'review-family',
    repository: 'deeeed/farmslot',
    prNumber: 1,
    priorReviewedHeadSha: '1111111',
    currentHeadSha: '2222222',
    verdict: 'pass',
    unresolvedFindings: [],
    artifactRefs: [],
    farmslotEvidenceRefs: [],
    contextMode: 'reuse',
    reviewScope: 'incremental',
    validationDepth: 'static-code',
    sessionIntent: ${JSON.stringify(sessionIntent)},
    priorGenerations: [],
  },
};
const prior = {
  id: 'review-generation-1',
  familyId: 'review-family',
  flowType: 'review-pr',
  status: 'done',
  project: 'farmslot-farm',
  slotId: ${JSON.stringify(slotId)},
  ticketOrPr: 'deeeed/farmslot#1',
  repeatReviewContext: null,
  agentContexts: [{
    id: 'review-context-1',
    role: 'review',
    label: 'Independent review',
    runner: ${JSON.stringify(runner)},
    slotId: ${JSON.stringify(slotId)},
    runId: 'review-generation-1',
    runnerSessionId: ${JSON.stringify(sessionId)},
    runnerSessionPath: ${JSON.stringify(sessionPath)},
    status: 'complete',
    startedAt: new Date().toISOString(),
  }],
};
const plan = resolveRepeatReviewResumePlan(current, prior, ${JSON.stringify(runner)});
if (plan.kind !== 'resume') {
  console.log(JSON.stringify({ kind: 'not-resumed', plan }));
  process.exit(${JSON.stringify(expectedKind)} === 'not-resumed' ? 0 : 1);
}
const result = await attemptRepeatReviewResume(plan, ${JSON.stringify(runner)}, {
  vars,
  target: ${JSON.stringify(target)},
  model: ${JSON.stringify(model)},
  prompt: ${JSON.stringify(prompt)},
  runtimeDir: '.agent',
  timeoutMs: ${timeoutMs},
});
console.log(JSON.stringify(result));
if (result.kind !== ${JSON.stringify(expectedKind)}) process.exit(1);
`;

  const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', snippet], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs + 90_000,
    env: {
      ...process.env,
      FARMSLOT_HOME: process.env.FARMSLOT_HOME ?? `${os.homedir()}/.farmslot-dev`,
    },
  });
  const stdout = result.stdout?.trim() ?? '';
  const jsonLine = stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .pop();
  return {
    result: jsonLine ? JSON.parse(jsonLine) : null,
    exitCode: result.status,
    error: result.stderr?.trim() || (!jsonLine ? stdout : null),
  };
}

/**
 * Production run-monitor stuck verdict against a live tmux target.
 * Clock is already past stuckTimeout so a pane-scrape monitor would have nudged.
 */
export function runGatewayMonitorStuck({
  repo,
  target,
  runner,
  panePid,
  stuckTimeoutMs = 20 * 60_000,
  elapsedMs = 21 * 60_000,
  timeoutMs = 30_000,
}) {
  const snippet = `
import os from 'node:os';
import { evaluateMonitorStuckForRunner } from './services/gateway/src/runners/observability-progress.ts';
import { isRunnerAliveUnderPane } from './services/gateway/src/runners/session-process.ts';

const vars = {
  slotId: 'runner-validate-local',
  machine: os.hostname(),
  platform: 'local',
  host: 'localhost',
  sshUser: os.userInfo().username,
  osType: process.platform === 'darwin' ? 'darwin' : 'linux',
  claudePath: '',
  codexPath: '',
  opencodePath: '',
  cursorPath: '',
  grokPath: '',
  dispatchCmd: '',
  recycleCmd: '',
  repo: ${JSON.stringify(repo)},
  session: ${JSON.stringify(target)},
  slotMode: 'dispatch',
  slotEnabled: true,
  sshTarget: \`\${os.userInfo().username}@localhost\`,
  remoteRepo: ${JSON.stringify(repo)},
  projectName: '',
  resourceVars: {},
};

const now = Date.now();
const verdict = await evaluateMonitorStuckForRunner({
  vars,
  target: ${JSON.stringify(target)},
  runner: ${JSON.stringify(runner)},
  now,
  lastProgressAt: now - ${elapsedMs},
  stuckTimeoutMs: ${stuckTimeoutMs},
});
const runnerAlive = ${JSON.stringify(panePid)}
  ? await isRunnerAliveUnderPane(vars, ${JSON.stringify(panePid)}, ${JSON.stringify(runner)})
  : false;
process.stdout.write(JSON.stringify({
  kind: verdict.kind,
  stuck: verdict.stuck,
  wouldNudge: verdict.wouldNudge,
  runnerAlive,
  activity: verdict.activity,
  turnState: verdict.turnState,
}) + '\\n');
`;

  const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', snippet], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: {
      ...process.env,
      FARMSLOT_HOME: process.env.FARMSLOT_HOME ?? `${os.homedir()}/.farmslot-dev`,
    },
  });
  const jsonLine = (result.stdout?.trim() ?? '')
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .pop();
  if (!jsonLine) {
    return {
      ok: false,
      error: result.stderr?.trim() || result.stdout?.trim() || 'monitor stuck probe failed',
      exitCode: result.status,
    };
  }
  return { ok: result.status === 0, exitCode: result.status, ...JSON.parse(jsonLine) };
}
