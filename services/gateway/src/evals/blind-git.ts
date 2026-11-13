import { readFileSync } from 'node:fs';

import { type EvalProofSource, primaryRoleForFlow, type Run } from '@farmslot/protocol';

import { runnerLaunchDir } from '../../../../scripts/lib/runner-runtime.cjs';
import { shSingleQuote } from '../../../../scripts/lib/shell-quote.mjs';
import { withFarmGitConfig } from '../core/farm-git.js';

export interface BlindGitSpec {
  slotId: string;
  slotEpoch: number;
  repo: string;
  capsule: string;
  /** Other slot checkouts on the node, which the worker sandbox cannot read. */
  siblingRepos?: string[];
  /** The node's resolved pool, runs and projects roots, which the worker sandbox cannot write. */
  farmConfigRoots?: string[];
  /** Configured ports for collision diagnostics; slot CDP is always denied. */
  slotResourcePorts?: Record<string, number>;
  runId: string;
  branch: string;
  baseSha: string;
  referenceCommits: string[];
  proof?: EvalProofSource;
  /** Captured from the admitted project/task, never from worker arguments. */
  proofBoundary?: {
    taskRoot: string;
    currentTask: string;
    runtimeRoots: string[];
    deniedRoots: string[];
  };
}

const script = readFileSync(new URL('./blind-git.py', import.meta.url), 'utf8');

export function buildBlindGitCommand(
  action: 'plan' | 'isolate' | 'boundary' | 'verify' | 'restore',
  spec: BlindGitSpec,
): string {
  // Each slot's launch directory, own slot first, as tmux-launch-script.ts writes it.
  const launchDirs = [spec.repo, ...(spec.siblingRepos ?? [])].map(runnerLaunchDir);
  return withFarmGitConfig(
    `python3 - ${shSingleQuote(JSON.stringify({ ...spec, launchDirs, action }))} <<'FARMSLOT_BLIND_GIT_PY'\n${script}\nFARMSLOT_BLIND_GIT_PY`,
  );
}

export type BlindTrialWorkerBoundary = Pick<BlindGitSpec, 'capsule' | 'baseSha'> & {
  browserCdpPort?: number;
};

/** Exact names only. Reasons and provider exceptions: ./blind-environment.md. */
const BLIND_ENVIRONMENT = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TZ',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'TMUX_PANE',
  'DISABLE_OMC',
  'DISABLE_OMX',
  'FARMSLOT_HOME',
  'FARMSLOT_CONFIG_DIR',
  'FARMSLOT_ROOT',
  'FARMSLOT_CLI',
  'FARMSLOT_TASK_DIR',
  'FARMSLOT_SLOT_ID',
  'FARMSLOT_MACHINE',
  'FARMSLOT_RUN_ID',
  'FARMSLOT_NODE22_BIN',
  'FARMSLOT_PROJECTS_DIR',
  'FARMSLOT_POOL_DIR',
  'FARMSLOT_RUNS_DIR',
  'FARMSLOT_NATIVE_STATE_DIR',
  'FARMSLOT_LOG_DIR',
  'FARMSLOT_SOURCE_RECEIPT',
  'FARMSLOT_SOURCE_LOCK_DIGEST',
  'FARMSLOT_SOURCE_PACK_ID',
  'FARMSLOT_SOURCE_PACK_ENTRY',
  'FARMSLOT_RECIPE_SOURCE_TRUST',
  'FARMSLOT_RECIPE_SOURCE_KIND',
  'FARMSLOT_RECIPE_SOURCE_NAME',
  'PI_CODING_AGENT_DIR',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR',
  'CURSOR_CONFIG_DIR',
  'CURSOR_DATA_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'GROK_HOME',
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_DIR',
  'GROK_ASK_USER_QUESTION',
  'OPENCODE_PERMISSION',
  'RECIPE_LIBRARY_PATH',
  'RECIPE_RUNTIME_DIR',
  'RECIPE_PROJECT_ROOT',
  'RECIPE_TASK_DIR',
  'RECIPE_SLOT_ID',
  'RECIPE_WALLET_FIXTURE',
  'RECIPE_WEB_DAPP_POLICY',
  'RECIPE_HARNESS_CHROME_BIN',
  'RECIPE_HARNESS_BROWSER',
  'TERMINAL_CHROME_BIN',
  'WATCHER_PORT',
  'METRO_PORT',
  'RECIPE_WATCHER_PORT',
  'TERMINAL_APP_PORT',
  'SIMULATOR_UDID',
  'IOS_SIMULATOR',
  'SIM_UDID',
  'ANDROID_DEVICE',
  'DEVICE_UDID',
  'ADB_SERIAL',
  'ANDROID_SERIAL',
  'ANDROID_HOME',
  'ANDROID_SDK_ROOT',
  'JAVA_HOME',
  'DEVELOPER_DIR',
  'SDKROOT',
  'ASDF_DATA_DIR',
  'NVM_DIR',
  'VOLTA_HOME',
  'COREPACK_HOME',
  'CI',
  'NODE_ENV',
  'PYTHONDONTWRITEBYTECODE',
  // Set by this wrapper, never admitted with ambient values.
  'GH_CONFIG_DIR',
  'ZDOTDIR',
  'GIT_TERMINAL_PROMPT',
  'FARMSLOT_CI_BASE_REF',
  'FARMSLOT_BLIND_SEATBELT',
  'FARMSLOT_BLIND_CDP_PORT',
  'FARMSLOT_BLIND_BROKER_DIR',
  'MAC_CHROMIUM_TMPDIR',
  'CDP_PORT',
  'RECIPE_CDP_PORT',
  'GIT_TRACE2_EVENT',
  'GIT_TRACE2_EVENT_NESTING',
  'GIT_SSH_COMMAND',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_KEY_0',
  'GIT_CONFIG_VALUE_0',
  'GIT_CONFIG_KEY_1',
  'GIT_CONFIG_VALUE_1',
];

/** Every name a blind worker may receive: the fixed list plus its runner's model entries. */
export function blindEnvironmentNames(modelEnvironment: readonly string[] = []): string[] {
  const names = [...BLIND_ENVIRONMENT, ...modelEnvironment];
  if (names.some((name) => !/^[A-Z_][A-Z0-9_]*$/.test(name)))
    throw new Error('Invalid blind model environment name');
  return names;
}

/** The blind launch shells' own environment. No credential, no startup file. */
const BLIND_LAUNCH_SHELL_ENVIRONMENT = [
  'HOME',
  'USER',
  'LOGNAME',
  'PATH',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TZ',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'TMUX',
  'TMUX_PANE',
];

/**
 * tmux pane command for a blind launch script. The pane's own shell exits into
 * `env -i` and a startup-file-free bash holding only the names above; the
 * worker's admitted names reach the script's subshell on fd 3, never through a
 * long-lived ancestor's environment or argv. See ./blind-environment.md.
 */
export function blindLaunchShellCommand(script: string, names: readonly string[]): string {
  const keep = BLIND_LAUNCH_SHELL_ENVIRONMENT.map((name) => `\${${name}+"${name}=$${name}"}`);
  // Separate `exec`s: a redirect on the final exec would leak the substitution's fd.
  const stage = [
    'script=$1; shift',
    `exec 3< <(for name in "$@"; do [ -z "\${!name+x}" ] || printf '%s=%s\\0' "$name" "\${!name}"; done)`,
    `exec /usr/bin/env -i ${keep.join(' ')} "$BASH" --noprofile --norc "$script"`,
  ].join('\n');
  return `exec bash --noprofile --norc -c ${shSingleQuote(stage)} farmslot-blind-launch ${script} ${names.join(' ')}`;
}

/**
 * Blind launch script body. The admitted values are read into an unexported
 * array; only the worker subshell exports them before its own `env -i`.
 */
export function blindLaunchScript(command: string, after: readonly string[] = []): string {
  return [
    '__farmslot_env=()',
    `while IFS= read -r -d '' __farmslot_kv; do __farmslot_env+=("$__farmslot_kv"); done <&3`,
    'exec 3<&-',
    '(',
    '[ ${#__farmslot_env[@]} -eq 0 ] || export "${__farmslot_env[@]}"',
    command,
    ')',
    ...after,
  ].join('\n');
}

/**
 * Start a blind worker without GitHub credentials, under the capsule's sandbox
 * profile (blind-git.py). Its gh, credential-helper and SSH-transport calls
 * reach the capsule's recording stand-ins, and Git's trace records refused transports.
 */
export function withBlindTrialBoundary(
  command: string,
  trial: BlindTrialWorkerBoundary,
  modelEnvironment: readonly string[] = [],
): string {
  const boundary = `${trial.capsule}/boundary`;
  const deny = shSingleQuote(`${boundary}/bin/deny`);
  const names = blindEnvironmentNames(modelEnvironment);
  // Quoted conditional expansion preserves empty values, spaces and newlines,
  // and omits unset variables. No parent environment enumeration or logging.
  const environment = names.map((name) => `\${${name}+"${name}=$${name}"}`).join(' ');
  return [
    'unset CDP_PORT RECIPE_CDP_PORT FARMSLOT_BLIND_CDP_PORT',
    `export FARMSLOT_CI_BASE_REF=${shSingleQuote(trial.baseSha)}`,
    `export GH_CONFIG_DIR=${shSingleQuote(`${boundary}/gh-config`)}`,
    // zsh always reads $ZDOTDIR/.zshenv; home startup files export operator secrets.
    `export ZDOTDIR=${shSingleQuote(`${boundary}/shell`)}`,
    `export PATH=${shSingleQuote(`${boundary}/bin`)}:"$PATH"`,
    `TMPDIR="$(/usr/bin/readlink ${shSingleQuote(`${boundary}/tmp`)})"`,
    'export TMPDIR TMP="$TMPDIR" TEMP="$TMPDIR" FARMSLOT_BLIND_BROKER_DIR="$TMPDIR/broker" MAC_CHROMIUM_TMPDIR="$TMPDIR"',
    'export GIT_TERMINAL_PROMPT=0',
    // Browser children must stay in this seatbelt; preserve TMUX_PANE for hooks.
    'export FARMSLOT_BLIND_SEATBELT=1',
    ...(trial.browserCdpPort
      ? [
          `export FARMSLOT_BLIND_CDP_PORT=${shSingleQuote(String(trial.browserCdpPort))} RECIPE_CDP_PORT=${shSingleQuote(String(trial.browserCdpPort))} CDP_PORT=${shSingleQuote(String(trial.browserCdpPort))}`,
        ]
      : []),
    // Records transports the isolated repository refuses, for any git binary.
    `export GIT_TRACE2_EVENT=${shSingleQuote(`${boundary}/git-trace.jsonl`)} GIT_TRACE2_EVENT_NESTING=1`,
    `export GIT_SSH_COMMAND=${shSingleQuote(`${deny} ssh`)}`,
    // An empty helper clears inherited helpers such as a keychain.
    'export GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0= GIT_CONFIG_KEY_1=credential.helper',
    `export GIT_CONFIG_VALUE_1=${shSingleQuote(`!${deny} credential`)}`,
    `/usr/bin/env -i ${environment} /usr/bin/sandbox-exec -f ${shSingleQuote(`${boundary}/sandbox.sb`)} /bin/sh -c ${shSingleQuote(command)}`,
  ].join(' && ');
}

/** The capsule a relaunched worker of a blind trial must start under; reviewers keep their own launch. */
export function blindTrialWorkerBoundary(
  run: Run | null | undefined,
  role?: string | null,
): BlindTrialWorkerBoundary | undefined {
  if (!run || (role && role !== primaryRoleForFlow(run.flowType))) return undefined;
  const trial = run.engineState?.evalExperiment?.blind;
  const capsule = trial?.isolation?.capsulePath;
  return trial && capsule
    ? { capsule, baseSha: trial.baseSha, browserCdpPort: trial.isolation?.browserCdpPort }
    : undefined;
}
