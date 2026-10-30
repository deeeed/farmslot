import { readFileSync } from 'node:fs';

import { shSingleQuote } from '../../../../scripts/lib/shell-quote.mjs';

export interface BlindGitSpec {
  slotId: string;
  slotEpoch: number;
  repo: string;
  capsule: string;
  /** Other slot checkouts on the node, which the worker sandbox cannot read. */
  siblingRepos?: string[];
  runId: string;
  branch: string;
  baseSha: string;
  referenceCommits: string[];
}

const script = readFileSync(new URL('./blind-git.py', import.meta.url), 'utf8');

export function buildBlindGitCommand(
  action: 'plan' | 'isolate' | 'verify' | 'restore',
  spec: BlindGitSpec,
): string {
  return `python3 - ${shSingleQuote(JSON.stringify({ ...spec, action }))} <<'FARMSLOT_BLIND_GIT_PY'\n${script}\nFARMSLOT_BLIND_GIT_PY`;
}

/** Variables `gh` and Git read a GitHub token from. */
const GITHUB_TOKEN_NAMES = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
];

/**
 * Start a blind worker without GitHub credentials, under the capsule's sandbox
 * profile (blind-git.py). Its gh, credential-helper and SSH-transport calls
 * reach the capsule's recording stand-ins instead.
 */
export function withBlindTrialBoundary(command: string, capsule: string): string {
  const boundary = `${capsule}/boundary`;
  const deny = shSingleQuote(`${boundary}/bin/deny`);
  return [
    `unset ${GITHUB_TOKEN_NAMES.join(' ')}`,
    `export GH_CONFIG_DIR=${shSingleQuote(`${boundary}/gh-config`)}`,
    `export PATH=${shSingleQuote(`${boundary}/bin`)}:"$PATH"`,
    'export GIT_TERMINAL_PROMPT=0',
    `export GIT_SSH_COMMAND=${shSingleQuote(`${deny} ssh`)}`,
    // An empty helper clears inherited helpers such as a keychain.
    'export GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0= GIT_CONFIG_KEY_1=credential.helper',
    `export GIT_CONFIG_VALUE_1=${shSingleQuote(`!${deny} credential`)}`,
    `/usr/bin/sandbox-exec -f ${shSingleQuote(`${boundary}/sandbox.sb`)} /bin/sh -c ${shSingleQuote(command)}`,
  ].join(' && ');
}
