// host-services/github-cli.ts — the only gateway work that still needs the `gh` binary.
//
// GitHub API traffic goes over HTTP (integrations/github-transport.ts). `gh` remains the keyring
// owner (credential and sign-in reads) and the resolver of a checkout's repository for the slot
// PR lookup without ci.repo, where its remote, SSH alias and url.insteadOf handling is the contract.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { isRecord } from '@farmslot/protocol';

import { registerHostOperations, withHostOperation } from '../observability/performance.js';

const execFileAsync = promisify(execFile);

export const GITHUB_CLI_OPS = {
  authToken: 'githubCli.authToken',
  authStatus: 'githubCli.authStatus',
  checkoutPRForBranch: 'githubCli.checkoutPRForBranch',
} as const;
registerHostOperations(Object.values(GITHUB_CLI_OPS));

/** The newest PR `gh pr list --head <branch>` finds for a checkout's repository. */
export interface CheckoutBranchPR {
  number: number;
  baseRefName?: string;
}

export interface GitHubCliService {
  /** `gh auth token` for a host (and named keyring account). Errors never carry gh's output. */
  authToken(host: string, login?: string): Promise<string>;
  /** `gh auth status --json hosts`, parsed; the ambient token variables are ignored. */
  authStatus(): Promise<unknown>;
  /** `gh pr list --head <branch>` run in the checkout, as gh resolves its repository. */
  checkoutPRForBranch(checkout: string, branch: string): Promise<CheckoutBranchPR | null>;
}

function keyringEnvironment(named: boolean): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GH_TOKEN;
  if (named) {
    delete env.GITHUB_TOKEN;
    delete env.GH_ENTERPRISE_TOKEN;
    delete env.GITHUB_ENTERPRISE_TOKEN;
  }
  return env;
}

async function authToken(host: string, login?: string): Promise<string> {
  let token: string;
  try {
    const result = await withHostOperation(GITHUB_CLI_OPS.authToken, () =>
      execFileAsync(
        'gh',
        ['auth', 'token', '--hostname', host, ...(login ? ['--user', login] : [])],
        {
          env: keyringEnvironment(Boolean(login)),
          timeout: 15_000,
          maxBuffer: 64 * 1024,
        },
      ),
    );
    token = result.stdout.trim();
  } catch {
    // Child errors can contain credential output. Report a fixed, actionable error instead.
    throw new Error(
      `GitHub account ${login ?? 'default'}@${host} is unavailable in the gateway keyring`,
    );
  }
  if (!token) throw new Error('GitHub account has no credential');
  return token;
}

async function authStatus(): Promise<unknown> {
  const { stdout } = await withHostOperation(GITHUB_CLI_OPS.authStatus, () =>
    execFileAsync('gh', ['auth', 'status', '--json', 'hosts'], {
      env: keyringEnvironment(true),
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    }),
  );
  return JSON.parse(stdout);
}

async function checkoutPRForBranch(
  checkout: string,
  branch: string,
): Promise<CheckoutBranchPR | null> {
  const { stdout } = await withHostOperation(GITHUB_CLI_OPS.checkoutPRForBranch, () =>
    execFileAsync(
      'gh',
      ['pr', 'list', '--head', branch, '--json', 'number,baseRefName', '--jq', '.[0]'],
      { cwd: checkout, env: keyringEnvironment(false), maxBuffer: 1024 * 1024 },
    ),
  );
  const found: unknown = JSON.parse(stdout || 'null');
  if (!isRecord(found) || typeof found.number !== 'number' || !found.number) return null;
  return {
    number: found.number,
    ...(typeof found.baseRefName === 'string' ? { baseRefName: found.baseRefName } : {}),
  };
}

export const githubCli: GitHubCliService = { authToken, authStatus, checkoutPRForBranch };
