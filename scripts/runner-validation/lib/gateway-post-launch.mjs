import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

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
