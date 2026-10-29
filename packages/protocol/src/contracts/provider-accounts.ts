/**
 * Operator provider subscription accounts for fleet UI.
 * Bind labels are farmslot-owned; identity/usage is mirrored from CodexBar (fail-open).
 * Tokens and credential paths are never included.
 */

import { canonicalResourceJson, type ResourceKey } from '../client-cache/keys.js';
import { Methods } from '../rpc/registry.js';
import type { UpstreamObservation } from '../rpc/resource-observers.js';

export type ProviderRunnerAccountStatusKind =
  | 'bound'
  | 'ambient'
  | 'unsupported'
  | 'unknown'
  | 'error';

export interface ProviderRunnerCoolingEntry {
  label: string;
  tier?: string;
  expiresAt?: string;
}

/** One credential entry; readiness does not establish billing or quota. */
export interface RunnerProviderAccount {
  id: string;
  provider: string;
  label?: string;
  email?: string;
  status: 'configured' | 'ready' | 'not_ready' | 'invalid' | 'unknown';
  authType: 'oauth' | 'api_key' | 'unknown';
  source: 'native-status' | 'credential-store';
}

export interface RunnerAccountInspection {
  command: string;
  description: string;
}

export interface RunnerAccountInventory {
  status: 'available' | 'unavailable' | 'unsupported';
  /** Host default configuration only; not the account used by every active run. */
  scope: 'host-default';
  accounts: RunnerProviderAccount[];
  /** Copy-only command prepared by the runner adapter; never contains credentials. */
  inspection?: RunnerAccountInspection;
  error?: string;
}

/** Live identity/quota mirrored from CodexBar on the execution host. */
export interface ProviderRunnerUsageMirror {
  /** Account email from CodexBar when available (not persisted on RunMetrics). */
  accountEmail: string | null;
  /** 0–100 remaining on the primary usage window when known. */
  remainingPercent: number | null;
  /** 0–100 used when remaining is not directly reported. */
  usedPercent: number | null;
  resetsAt: string | null;
  loginMethod: string | null;
  /** CodexBar source tag (oauth, web, cli, …). */
  source: string | null;
  /** Fail-open probe error; row still returns without blocking UI. */
  error?: string;
}

/** Source age of each independently retained part of one runner row. */
export interface ProviderRunnerObservations {
  identity: UpstreamObservation;
  quota: UpstreamObservation;
  /** Host cooling ledger, only for runners with account failover. */
  cooling?: UpstreamObservation;
}

/** One runner's connected subscription on a machine. */
export interface ProviderRunnerAccountStatus {
  runner: string;
  /** Provider-aware, read-only inventory. Older gateways may omit it. */
  inventory?: RunnerAccountInventory;
  status: ProviderRunnerAccountStatusKind;
  /** Operator-local account label, or null when ambient/unsupported. */
  activeLabel: string | null;
  /** How the label was chosen: active-profile | slot-binding | ambient | … */
  source?: string | null;
  /** Labels currently cooling on this host (session/extended). */
  cooling?: ProviderRunnerCoolingEntry[];
  /** CodexBar mirror — email + quota for the node-active seat. */
  usage?: ProviderRunnerUsageMirror | null;
  error?: string;
  /** Older gateways omit it. */
  observations?: ProviderRunnerObservations;
}

export interface MachineProviderAccountsSnapshot {
  machine: string;
  runners: ProviderRunnerAccountStatus[];
  checkedAt: string;
  /** False when the host could not be probed (remote offline, etc.). */
  reachable?: boolean;
  /** Ready only when every component is; otherwise its oldest known success. */
  observation?: UpstreamObservation;
}

export interface ProviderAccountsSnapshot {
  machines: MachineProviderAccountsSnapshot[];
  checkedAt: string;
  /** Conservative over the selected machines. */
  observation?: UpstreamObservation;
}

const MAX_STORED_MACHINES = 256;
const MAX_STORED_ENTRIES = 64;
const MAX_OBSERVED_MACHINES = 64;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const EMAIL = /^[^\s@]{1,128}@[^\s@]{1,125}$/;

/**
 * Observer identity: never a forced probe; machines sorted and deduped. Empty and
 * omitted `machines` both select every fleet machine.
 */
export function providerAccountsObservationParams(params: unknown): { machines?: string[] } {
  if (params == null) return {};
  if (typeof params !== 'object' || Array.isArray(params))
    throw new Error('Provider account observations require an object');
  const record = params as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !['machines', 'forceRefresh'].includes(key)) ||
    (record.forceRefresh !== undefined && record.forceRefresh !== false)
  )
    throw new Error(
      'Provider account observations cannot force a probe or supply unregistered selectors',
    );
  const machines = record.machines;
  if (machines === undefined) return {};
  if (
    !Array.isArray(machines) ||
    machines.length > MAX_OBSERVED_MACHINES ||
    machines.some((machine) => typeof machine !== 'string' || !IDENTIFIER.test(machine))
  )
    throw new Error('Provider account observations require valid machine identifiers');
  return machines.length ? { machines: [...new Set(machines as string[])].sort() } : {};
}

function providerAccountsKey(machines?: string[]): ResourceKey {
  return {
    family: 'upstream',
    integration: 'providers',
    queryId: `${Methods.PROVIDER_ACCOUNTS_SNAPSHOT}:${canonicalResourceJson(machines ? { machines } : {})}`,
  };
}

/**
 * One key per named machine (its single-machine collector id); the all-machines
 * identity also follows fleet topology. Imperative force flags do not change keys.
 */
export function providerAccountsDependencies(params: unknown): ResourceKey[] {
  const machines =
    params && typeof params === 'object' ? Reflect.get(params, 'machines') : undefined;
  const normalized = providerAccountsObservationParams(machines === undefined ? {} : { machines });
  return normalized.machines
    ? normalized.machines.map((machine) => providerAccountsKey([machine]))
    : [providerAccountsKey(), { family: 'slots', scope: 'farm' }];
}

/** Keys the gateway advances when one machine's retained snapshot changes. */
export function providerAccountsChangedKeys(machine: string): ResourceKey[] {
  return [providerAccountsKey([machine]), providerAccountsKey()];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && IDENTIFIER.test(value) ? value : undefined;
}

function label(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 128 && !/^\s*$|\p{Cc}/u.test(value)
    ? value
    : undefined;
}

function timestamp(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value))
    ? value
    : undefined;
}

function percent(value: unknown): number | null {
  return typeof value === 'number' && value >= 0 && value <= 100 ? value : null;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return allowed.find((item) => item === value);
}

function list<T>(value: unknown, item: (value: unknown) => T | undefined): T[] {
  return Array.isArray(value)
    ? value
        .slice(0, MAX_STORED_ENTRIES)
        .map(item)
        .filter((entry): entry is T => entry !== undefined)
    : [];
}

function storedObservation(value: unknown): UpstreamObservation | undefined {
  const observation = record(value);
  const status = oneOf(observation?.status, ['ready', 'stale', 'error'] as const);
  if (!observation || !status) return undefined;
  const observedAt = observation.observedAt;
  const error = record(observation.error);
  const code = identifier(error?.code);
  const message = label(error?.message);
  return {
    status,
    ...(typeof observedAt === 'number' && Number.isFinite(observedAt) && observedAt > 0
      ? { observedAt }
      : {}),
    ...(code && message ? { error: { code, message } } : {}),
  };
}

function storedAccount(value: unknown): RunnerProviderAccount | undefined {
  const account = record(value);
  const id = label(account?.id);
  const provider = identifier(account?.provider);
  if (!account || !id || !provider) return undefined;
  const accountLabel = label(account.label);
  const email = typeof account.email === 'string' && EMAIL.test(account.email);
  return {
    id,
    provider,
    ...(accountLabel ? { label: accountLabel } : {}),
    ...(email ? { email: account.email as string } : {}),
    status:
      oneOf(account.status, ['configured', 'ready', 'not_ready', 'invalid', 'unknown'] as const) ??
      'unknown',
    authType: oneOf(account.authType, ['oauth', 'api_key', 'unknown'] as const) ?? 'unknown',
    source:
      oneOf(account.source, ['native-status', 'credential-store'] as const) ?? 'native-status',
  };
}

function storedRunner(value: unknown): ProviderRunnerAccountStatus | undefined {
  const row = record(value);
  const runner = identifier(row?.runner);
  if (!row || !runner) return undefined;
  const inventory = record(row.inventory);
  const inventoryStatus = oneOf(inventory?.status, [
    'available',
    'unavailable',
    'unsupported',
  ] as const);
  const usage = record(row.usage);
  const email = typeof usage?.accountEmail === 'string' && EMAIL.test(usage.accountEmail);
  const observations = record(row.observations);
  const identity = storedObservation(observations?.identity);
  const quota = storedObservation(observations?.quota);
  const cooling = storedObservation(observations?.cooling);
  const source = identifier(row.source);
  const entries = list(row.cooling, (value) => {
    const entry = record(value);
    const entryLabel = label(entry?.label);
    if (!entry || !entryLabel) return undefined;
    const tier = identifier(entry.tier);
    const expiresAt = timestamp(entry.expiresAt);
    return {
      label: entryLabel,
      ...(tier ? { tier } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    };
  });
  // Inspection commands, credential paths and raw probe errors stay live-only.
  return {
    runner,
    ...(inventoryStatus
      ? {
          inventory: {
            status: inventoryStatus,
            scope: 'host-default' as const,
            accounts: list(inventory?.accounts, storedAccount),
          },
        }
      : {}),
    status:
      oneOf(row.status, ['bound', 'ambient', 'unsupported', 'unknown', 'error'] as const) ??
      'unknown',
    activeLabel: label(row.activeLabel) ?? null,
    ...(source ? { source } : {}),
    ...(entries.length ? { cooling: entries } : {}),
    usage: usage
      ? {
          accountEmail: email ? (usage.accountEmail as string) : null,
          remainingPercent: percent(usage.remainingPercent),
          usedPercent: percent(usage.usedPercent),
          resetsAt: timestamp(usage.resetsAt) ?? null,
          loginMethod: label(usage.loginMethod) ?? null,
          source: identifier(usage.source) ?? null,
        }
      : null,
    ...(identity && quota
      ? { observations: { identity, quota, ...(cooling ? { cooling } : {}) } }
      : {}),
  };
}

/** Durable projection: explicit identifiers, bounded identity, enums, numbers and source ages. */
export function providerAccountsStoredData(data: unknown): ProviderAccountsSnapshot {
  const snapshot = record(data);
  const observation = storedObservation(snapshot?.observation);
  return {
    machines: (Array.isArray(snapshot?.machines) ? snapshot.machines : [])
      .slice(0, MAX_STORED_MACHINES)
      .flatMap((value): MachineProviderAccountsSnapshot[] => {
        const row = record(value);
        const machine = identifier(row?.machine);
        if (!row || !machine) return [];
        const machineObservation = storedObservation(row.observation);
        return [
          {
            machine,
            runners: list(row.runners, storedRunner),
            checkedAt: timestamp(row.checkedAt) ?? '',
            ...(typeof row.reachable === 'boolean' ? { reachable: row.reachable } : {}),
            ...(machineObservation ? { observation: machineObservation } : {}),
          },
        ];
      }),
    checkedAt: timestamp(snapshot?.checkedAt) ?? '',
    ...(observation ? { observation } : {}),
  };
}
