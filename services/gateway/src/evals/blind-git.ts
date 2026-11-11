import { readFileSync } from 'node:fs';

import { type EvalProofSource, primaryRoleForFlow, type Run } from '@farmslot/protocol';

import { shSingleQuote } from '../../../../scripts/lib/shell-quote.mjs';

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
  return `python3 - ${shSingleQuote(JSON.stringify({ ...spec, action }))} <<'FARMSLOT_BLIND_GIT_PY'\n${script}\nFARMSLOT_BLIND_GIT_PY`;
}

export type BlindTrialWorkerBoundary = Pick<BlindGitSpec, 'capsule' | 'baseSha'>;

/** Variables `gh` and Git read a GitHub token from. */
const GITHUB_TOKEN_NAMES = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
];

// Blind task markers write CHECKLIST/SIGNAL files. They need no gateway RPC;
// the ordinary automation profile can execute outside the worker's seatbelt.
const GATEWAY_ENV_NAMES = [
  'FARMSLOT_NODE_TOKEN',
  'FARMSLOT_GATEWAY_TOKEN',
  'FARMSLOT_GATEWAY_PASSWORD',
  'GW_URL',
  'GATEWAY_URL',
  'FARMSLOT_GATEWAY',
  'FARMSLOT_GATEWAY_PROFILE',
];

/**
 * Start a blind worker without GitHub credentials, under the capsule's sandbox
 * profile (blind-git.py). Its gh, credential-helper and SSH-transport calls
 * reach the capsule's recording stand-ins, and Git's trace records refused transports.
 */
export function withBlindTrialBoundary(command: string, trial: BlindTrialWorkerBoundary): string {
  const boundary = `${trial.capsule}/boundary`;
  const deny = shSingleQuote(`${boundary}/bin/deny`);
  return [
    `unset ${[...GITHUB_TOKEN_NAMES, ...GATEWAY_ENV_NAMES].join(' ')} TMUX TMUX_TMPDIR SSH_AUTH_SOCK SSH_AGENT_PID`,
    `export FARMSLOT_CI_BASE_REF=${shSingleQuote(trial.baseSha)}`,
    `export GH_CONFIG_DIR=${shSingleQuote(`${boundary}/gh-config`)}`,
    `export PATH=${shSingleQuote(`${boundary}/bin`)}:"$PATH"`,
    'export GIT_TERMINAL_PROMPT=0',
    // Browser children must stay in this seatbelt; preserve TMUX_PANE for hooks.
    'export FARMSLOT_BLIND_SEATBELT=1',
    // Records transports the isolated repository refuses, for any git binary.
    `export GIT_TRACE2_EVENT=${shSingleQuote(`${boundary}/git-trace.jsonl`)} GIT_TRACE2_EVENT_NESTING=1`,
    `export GIT_SSH_COMMAND=${shSingleQuote(`${deny} ssh`)}`,
    // An empty helper clears inherited helpers such as a keychain.
    'export GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0= GIT_CONFIG_KEY_1=credential.helper',
    `export GIT_CONFIG_VALUE_1=${shSingleQuote(`!${deny} credential`)}`,
    `/usr/bin/sandbox-exec -f ${shSingleQuote(`${boundary}/sandbox.sb`)} /bin/sh -c ${shSingleQuote(command)}`,
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
  return trial && capsule ? { capsule, baseSha: trial.baseSha } : undefined;
}
