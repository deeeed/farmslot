import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { withMachineEnv } from '../../../../services/gateway/src/core/project-env.ts';
import {
  buildCodexHomeSetup,
  buildInteractiveRefinementRunnerCommand,
  buildLaunchCommand,
  buildRunnerSessionReloadCommand,
} from '../../../../services/gateway/src/runners/launch-command.ts';
import { buildRunnerObservabilityInstallCommand } from '../../../../services/gateway/src/runners/runner-observability.ts';

// Lane policy supplies context. CLI syntax and hook installation remain in the shared runner adapter.
export function persistentLaneCommand(command) {
  // A subshell also contains an adapter's exec; handle failure under a caller's set -e.
  return `if ( ${command} ); then lane_runner_exit=0; else lane_runner_exit=$?; fi; printf 'Lane runner exited with status %s. Recover with launch and resume_id.\\n' "$lane_runner_exit"; exec "\${SHELL:-/bin/sh}" -i`;
}

export function runnerLaunch(lane) {
  if (!['codex', 'claude'].includes(lane.runner))
    throw new Error('Lane launcher supports codex and claude');
  if (!lane.id || !lane.cwd || !lane.runtime_dir)
    throw new Error('id, cwd and runtime_dir are required');
  if (
    lane.safety_tier !== undefined &&
    !['sandboxed', 'full-auto', 'dangerous'].includes(lane.safety_tier)
  )
    throw new Error('Unknown safety_tier');
  const cwd = fs.realpathSync(lane.cwd);
  const runtime = path.resolve(lane.runtime_dir);
  const relativeRuntime = path.relative(cwd, runtime);
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const vars = {
    slotId: lane.id,
    host: 'localhost',
    remoteRepo: cwd,
    remoteHome: os.homedir(),
    projectName: lane.project || 'orchestration',
    machine: lane.machine || 'local',
    dispatchCmd: '',
    codexPath: lane.runner === 'codex' ? lane.binary : undefined,
    claudePath: lane.runner === 'claude' ? lane.binary : undefined,
    machineEnv: lane.env || {},
  };
  const opts = {
    repo: cwd,
    runtimeDir: relativeRuntime,
    safetyTier: lane.safety_tier,
    effort: lane.effort,
    codexAccountLabel: lane.account_label,
    skipUpdateCheck: true,
  };
  let command;
  if (lane.resume_id) {
    command = buildRunnerSessionReloadCommand(vars, lane.runner, lane.model, lane.resume_id, opts);
  } else if (lane.runner === 'codex') {
    const promptPath = path.join(runtime, 'bootstrap-prompt.txt');
    fs.writeFileSync(promptPath, 'Reply READY, then wait for the lane goal. Do not use tools.', {
      mode: 0o600,
    });
    const launch = buildInteractiveRefinementRunnerCommand({
      runner: lane.runner,
      repo: cwd,
      binary: lane.binary,
      model: lane.model,
      promptPath,
      effort: lane.effort,
      safetyTier: lane.safety_tier,
      workspaceTrust: 'trusted',
      skipUpdateCheck: true,
    });
    command = withMachineEnv(
      `${buildRunnerObservabilityInstallCommand(vars, lane.runner, cwd, relativeRuntime, { accountLabel: lane.account_label })} && ${buildCodexHomeSetup(cwd, relativeRuntime)} && ${launch}`,
      vars,
    );
  } else {
    command = buildLaunchCommand(vars, lane.runner, lane.model, '', opts);
  }
  const localGoal =
    lane.goal_command === '/goal' &&
    [
      path.join(cwd, '.claude', 'skills', 'goal', 'SKILL.md'),
      path.join(cwd, '.claude', 'commands', 'goal.md'),
    ].some((file) => fs.existsSync(file));
  if (lane.runner === 'claude' && lane.goal_command === '/goal' && !localGoal)
    throw new Error('Claude /goal requires a local goal skill or command');
  const goalSupported = lane.runner === 'codex' || localGoal;
  return {
    command: persistentLaneCommand(command),
    runtime_dir: runtime,
    observability_dir: path.join(runtime, '.observability'),
    goal_supported: goalSupported,
    goal_prefix: goalSupported ? '/goal' : '',
    bootstrap_pending: lane.runner === 'codex' && !lane.resume_id,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.stdout.write(
      `${JSON.stringify(runnerLaunch(JSON.parse(fs.readFileSync(0, 'utf8'))))}\n`,
    );
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exitCode = 2;
  }
}
