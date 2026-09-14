import path from 'node:path';

import type { NativeWorkerLaunch } from '@farmslot/agent-runtime/native';
import type { NativeProfileReference, SafetyTier } from '@farmslot/protocol';

import { execOnSlot } from '../../core/exec.js';
import {
  expandTemplate,
  loadSlotVars,
  type ProjectVars,
  type RawProjectJson,
} from '../../core/index.js';
import { resolveProjectCommandEnv } from '../../core/project-env.js';
import { shellQuote } from '../../core/tmux.js';
import { ensureNodeSupportBundle } from '../../node-support/ensure.js';
import {
  resolveCodexBinary,
  resolveRunnerEffort,
  taskRecipeTrustEnvironment,
} from '../launch-command.js';
import { normalizeRunner, runnerSupportsEffort } from '../registry.js';
import { buildRunnerObservabilityInstallCommand } from '../runner-observability.js';
import { resolveRunnerAccountForDispatch } from '../status-provider.js';

import { validateNativeRunner } from './manager.js';
import { assertNativeProfileSlot } from './worker-profile.js';

export async function prepareNativeWorkerLaunch(input: {
  vars: Awaited<ReturnType<typeof loadSlotVars>>;
  project: RawProjectJson;
  projectVars?: ProjectVars;
  runner: string;
  model: string;
  effort?: string;
  safetyTier: SafetyTier;
  domain?: string;
  taskDir: string;
  leaseId: string;
  sessionId: string;
  prepareAccount: boolean;
  accountLabel?: string;
  profile?: NativeProfileReference;
  stateDirectory?: string;
  recordAccount?: (label: string | undefined) => Promise<void>;
}): Promise<{ launch: NativeWorkerLaunch; accountLabel?: string }> {
  const { vars } = input;
  const runner = normalizeRunner(input.runner);
  if (input.profile) {
    assertNativeProfileSlot(input.profile, vars);
    if (input.profile.runner !== runner)
      throw new Error('Selected native profile belongs to another runner');
    if (input.accountLabel)
      throw new Error('Choose either a native configuration profile or a legacy account label');
  }
  validateNativeRunner(runner, input.model);
  const effort = resolveRunnerEffort(runner, input.effort);
  if (!runnerSupportsEffort(runner, input.model, effort))
    throw new Error('Selected native runner/model does not support this effort');
  const environment = resolveProjectCommandEnv(input.project, {
    domain: input.domain,
    expandDomainValue: (value) =>
      expandTemplate(value, vars, input.projectVars, { domain: input.domain ?? '' }),
  });
  // Match terminal launches: pool values override project command_env, while
  // the task trust and runner account settings below remain runtime-owned.
  environment.set = { ...environment.set, ...vars.machineEnv };
  environment.unset = environment.unset.filter(
    (name) => !Object.hasOwn(vars.machineEnv ?? {}, name),
  );
  const taskRoot = path.posix.isAbsolute(input.taskDir)
    ? input.taskDir
    : path.posix.join(vars.remoteRepo, input.taskDir);
  const inherited = await execOnSlot(
    vars,
    `test -f ${shellQuote(path.posix.join(taskRoot, 'inputs/inherited/recipe-source.json'))}`,
  );
  if (inherited.exitCode !== 0 && inherited.exitCode !== 1)
    throw new Error('Cannot establish native worker recipe-source ownership');
  const trust = taskRecipeTrustEnvironment(inherited.exitCode === 0);
  for (const name of trust.unset) delete environment.set[name];
  environment.unset = [...new Set([...environment.unset, ...trust.unset])];
  environment.set = { ...environment.set, ...trust.set };

  let accountLabel = input.accountLabel;
  let launchAccountLabel: string | null | undefined;
  if (input.prepareAccount && !input.profile) {
    const account = await resolveRunnerAccountForDispatch({
      vars,
      runnerId: runner,
      slotId: vars.slotId,
      forcedLabel: accountLabel,
    });
    if (!account && accountLabel)
      throw new Error('This native runner does not support named account binding');
    accountLabel = account?.account.label ?? accountLabel;
    launchAccountLabel = account?.bind.launchAccountLabel;
    await input.recordAccount?.(accountLabel);
  }
  let executable: string;
  if (runner === 'codex' && !input.profile) {
    const legacyRuntimeDir = path.posix.join(
      input.projectVars?.runtimeDir ?? '.agent',
      'native-workers',
      input.sessionId,
    );
    const installRepo = input.stateDirectory ?? vars.remoteRepo;
    const runtimeDir = input.stateDirectory ? '.' : legacyRuntimeDir;
    if (input.prepareAccount) {
      const support = await ensureNodeSupportBundle(
        vars,
        input.projectVars?.runtimeDir ?? '.agent',
        {
          projectVars: input.projectVars,
        },
      );
      const installed = await execOnSlot(
        vars,
        buildRunnerObservabilityInstallCommand(vars, runner, installRepo, runtimeDir, {
          accountLabel: launchAccountLabel,
          supportDir: support?.supportDir,
        }),
      );
      if (installed.exitCode !== 0)
        throw new Error(
          `Native worker account setup failed on ${vars.machine} (exit ${installed.exitCode})`,
        );
    }
    const home = path.posix.join(installRepo, runtimeDir, 'codex-home');
    const ready = await execOnSlot(
      vars,
      `test -f ${shellQuote(path.posix.join(home, 'config.toml'))}`,
    );
    if (ready.exitCode !== 0)
      throw new Error(
        'Native worker account configuration is unavailable; refresh native setup before dispatch',
      );
    environment.set.CODEX_HOME = home;
    executable = resolveCodexBinary(vars.codexPath);
  } else if (runner === 'codex') {
    executable = resolveCodexBinary(vars.codexPath);
  } else if (runner === 'claude') {
    executable = vars.claudePath || 'claude';
  } else {
    throw new Error('Native worker launch is unavailable for this runner');
  }
  return {
    accountLabel,
    launch: {
      leaseId: input.leaseId,
      executable,
      environment,
      safetyTier: input.safetyTier,
      ...(accountLabel ? { accountLabel } : {}),
      ...(effort ? { effort } : {}),
    },
  };
}
