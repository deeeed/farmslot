/**
 * Execute provider-account operations on the slot's host (local or remote).
 * Paths and ledger always expand against the execution machine's FARMSLOT_HOME.
 */

import os from 'node:os';
import path from 'node:path';

import type { loadSlotVars } from '../core/config.js';
import { execOnSlot, isLocal } from '../core/exec.js';
import { shellExpressionForRemotePath } from '../core/remote-paths.js';
import { shellQuote } from '../core/tmux.js';
import { farmslotRoot } from '../projects/repo-root.js';

import {
  AMBIENT_ACCOUNT_LABEL,
  loadActiveProviderProfiles,
  loadProviderAccountsConfig,
  providerFailoverCandidates,
  type ResolvedProviderAccount,
  resolveProviderAccountForSlot,
} from './provider-accounts.js';
import {
  earliestExhaustionExpiry,
  filterEligibleLabels,
  isAccountExhausted,
  loadExhaustionLedger,
  markAccountExhausted,
  recordAccountSuccess,
} from './usage-exhaustion-ledger.js';

const REMOTE_AGENT_DIR = '~/farmslot-node';
const CLI_REL = 'scripts/provider-account-cli.mjs';
const localHostname = os.hostname().replace(/\.local$/, '');

function farmslotDirForSlot(vars: Awaited<ReturnType<typeof loadSlotVars>>): string {
  const slotHost = vars.host.replace(/\.local$/, '');
  const local =
    slotHost === 'localhost' ||
    slotHost === '127.0.0.1' ||
    slotHost === localHostname ||
    isLocal(vars.host, vars.machine);
  return local ? farmslotRoot : REMOTE_AGENT_DIR;
}

function cliPathForSlot(vars: Awaited<ReturnType<typeof loadSlotVars>>): string {
  return path.posix.join(farmslotDirForSlot(vars), CLI_REL);
}

function parseJsonLine(stdout: string): Record<string, unknown> {
  const line = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) throw new Error('provider-account-cli produced no JSON output');
  return JSON.parse(line) as Record<string, unknown>;
}

async function runHostCli(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  argvTail: string[],
): Promise<Record<string, unknown>> {
  const cli = cliPathForSlot(vars);
  const cmd = [
    'node',
    shellExpressionForRemotePath(cli),
    ...argvTail.map((part) => shellQuote(part)),
  ].join(' ');
  const result = await execOnSlot(vars, cmd, { timeout: 15_000 });
  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonLine(result.stdout || result.stderr || '');
  } catch (err) {
    throw new Error(
      `provider-account-cli failed on ${vars.machine}/${vars.slotId}: ${(err as Error).message}; stdout=${result.stdout}; stderr=${result.stderr}; exit=${result.exitCode}`,
    );
  }
  if (result.exitCode !== 0 || parsed.ok === false) {
    throw new Error(
      String(parsed.error || result.stderr || result.stdout || `exit ${result.exitCode}`),
    );
  }
  return parsed;
}

function useInProcessLocal(vars: Awaited<ReturnType<typeof loadSlotVars>>): boolean {
  return isLocal(vars.host, vars.machine);
}

export async function hostResolveProviderAccount(options: {
  vars: Awaited<ReturnType<typeof loadSlotVars>>;
  slotId: string;
  provider?: string;
  forcedLabel?: string | null;
}): Promise<ResolvedProviderAccount & { source?: string }> {
  const provider = options.provider ?? 'codex';
  if (useInProcessLocal(options.vars)) {
    return resolveProviderAccountForSlot({
      slotId: options.slotId,
      provider,
      forcedLabel: options.forcedLabel,
    });
  }
  const args = ['resolve', '--slot-id', options.slotId, '--provider', provider];
  if (options.forcedLabel?.trim()) {
    args.push('--label', options.forcedLabel.trim());
  }
  const parsed = await runHostCli(options.vars, args);
  return {
    label: String(parsed.label || AMBIENT_ACCOUNT_LABEL),
    provider: String(parsed.provider || provider),
    authPath: String(parsed.authPath || ''),
    ambient: Boolean(parsed.ambient),
    source: typeof parsed.source === 'string' ? parsed.source : undefined,
  };
}

export async function hostListEligibleLabels(options: {
  vars: Awaited<ReturnType<typeof loadSlotVars>>;
  provider?: string;
  exclude?: string[];
}): Promise<{ eligible: string[]; all: string[]; earliestExpiry: string | null }> {
  const provider = options.provider ?? 'codex';
  const exclude = options.exclude ?? [];
  if (useInProcessLocal(options.vars)) {
    const all = providerFailoverCandidates({ provider, exclude: [] });
    const eligible = filterEligibleLabels(providerFailoverCandidates({ provider, exclude }));
    return {
      eligible,
      all,
      earliestExpiry: earliestExhaustionExpiry(all),
    };
  }
  const args = ['list-eligible', '--provider', provider];
  if (exclude.length) args.push('--exclude', exclude.join(','));
  const parsed = await runHostCli(options.vars, args);
  return {
    eligible: Array.isArray(parsed.eligible) ? (parsed.eligible as string[]) : [],
    all: Array.isArray(parsed.all) ? (parsed.all as string[]) : [],
    earliestExpiry: typeof parsed.earliestExpiry === 'string' ? parsed.earliestExpiry : null,
  };
}

export async function hostMarkAccountExhausted(options: {
  vars: Awaited<ReturnType<typeof loadSlotVars>>;
  label: string;
  provider?: string;
}): Promise<void> {
  const provider = options.provider ?? 'codex';
  if (useInProcessLocal(options.vars)) {
    markAccountExhausted({ label: options.label, provider });
    return;
  }
  await runHostCli(options.vars, [
    'mark-exhausted',
    '--label',
    options.label,
    '--provider',
    provider,
  ]);
}

export async function hostRecordAccountSuccess(options: {
  vars: Awaited<ReturnType<typeof loadSlotVars>>;
  label: string;
}): Promise<void> {
  if (useInProcessLocal(options.vars)) {
    recordAccountSuccess({ label: options.label });
    return;
  }
  await runHostCli(options.vars, ['record-success', '--label', options.label]);
}

export async function hostGetActiveProfile(options: {
  vars: Awaited<ReturnType<typeof loadSlotVars>>;
  provider?: string;
}): Promise<string | null> {
  const provider = options.provider ?? 'codex';
  if (useInProcessLocal(options.vars)) {
    return loadActiveProviderProfiles()[provider] ?? null;
  }
  const parsed = await runHostCli(options.vars, ['get-active', '--provider', provider]);
  return typeof parsed.label === 'string' ? parsed.label : null;
}

/** Prefer label-only install args so the execution host expands credential paths. */
export function buildProviderAccountInstallArgs(label: string | null | undefined): {
  accountLabel?: string;
  authSource?: null;
} {
  if (!label?.trim()) return {};
  return { accountLabel: label.trim(), authSource: null };
}

export function hostHasProviderAccountsConfig(): boolean {
  return loadProviderAccountsConfig() !== null;
}

export function hostIsAccountExhaustedLocal(label: string): boolean {
  return isAccountExhausted(label, { ledger: loadExhaustionLedger() });
}
