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
    exitCode: result.status,
    stderr: result.stderr?.trim() || null,
  };
}
