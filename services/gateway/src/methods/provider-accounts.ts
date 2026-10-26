/**
 * Provider subscription snapshot for fleet UI — per machine × runner.
 * Built via {@link getHostRunnerSubscriptions} on {@link RunnerStatusProvider}.
 */

import type {
  ProviderAccountsSnapshotParams,
  ProviderAccountsSnapshotResult,
  ProviderRunnerAccountStatus,
  ProviderRunnerCoolingEntry,
  ProviderRunnerUsageMirror,
} from '@farmslot/protocol';

import { loadSlotVars } from '../core/config.js';
import { isLocal } from '../core/exec.js';
import { loadFleetStatus } from '../fleet/state.js';
import {
  ProviderAccountObservation,
  type ProviderAccountsReadInterest,
  type ProviderSeatRunnerSample,
  type ProviderSeatSample,
} from '../resources/provider-account-observation.js';
import { hostListEligibleLabels } from '../runners/provider-account-host.js';
import {
  FLEET_SUBSCRIPTION_RUNNERS,
  getHostRunnerSubscriptions,
  type RunnerActiveSubscription,
} from '../runners/status-provider.js';
import { loadExhaustionLedger } from '../runners/usage-exhaustion-ledger.js';

function statusFromSubscription(
  sub: RunnerActiveSubscription,
): ProviderRunnerAccountStatus['status'] {
  if (sub.inventory) {
    if (sub.inventory.status === 'unavailable') return 'error';
    if (sub.inventory.status === 'unsupported') return 'unsupported';
    if (!sub.supportsAccountBinding) return sub.inventory.accounts.length ? 'ambient' : 'unknown';
  }
  if (sub.source === 'error' && !sub.accountEmail && !sub.accountLabel) return 'error';
  if (sub.source === 'unsupported' && !sub.accountEmail) return 'unsupported';
  if (sub.supportsAccountBinding) {
    if (sub.accountLabel && sub.accountLabel !== 'ambient' && sub.source !== 'ambient') {
      return 'bound';
    }
    return 'ambient';
  }
  if (sub.accountEmail || sub.usedPercent != null || sub.remainingPercent != null) {
    return 'ambient';
  }
  return 'unsupported';
}

function usageFromSubscription(sub: RunnerActiveSubscription): ProviderRunnerUsageMirror | null {
  if (
    !sub.accountEmail &&
    sub.remainingPercent == null &&
    sub.usedPercent == null &&
    !sub.resetsAt &&
    !sub.loginMethod &&
    !sub.error
  ) {
    return null;
  }
  return {
    accountEmail: sub.accountEmail,
    remainingPercent: sub.remainingPercent,
    usedPercent: sub.usedPercent,
    resetsAt: sub.resetsAt,
    loginMethod: sub.loginMethod,
    // Prefer status-provider source (native auth / codexbar / bind).
    source:
      sub.source === 'claude-auth' ||
      sub.source === 'grok-auth' ||
      sub.source === 'codex-auth' ||
      sub.source === 'cursor-auth' ||
      sub.source === 'codexbar' ||
      sub.source === 'farmslot-bind' ||
      sub.source === 'active-profile' ||
      sub.source === 'ambient'
        ? sub.source
        : sub.codexBarProviderId
          ? 'codexbar'
          : null,
    ...(sub.error ? { error: sub.error } : {}),
  };
}

async function coolingForCodex(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
): Promise<{ entries: ProviderRunnerCoolingEntry[] } | { failed: true }> {
  try {
    if (isLocal(vars.host, vars.machine)) {
      const ledger = loadExhaustionLedger();
      const now = Date.now();
      return {
        entries: Object.values(ledger.entries)
          .filter((e) => e.provider === 'codex' && Date.parse(e.expiresAt) > now)
          .map((e) => ({ label: e.label, tier: e.tier, expiresAt: e.expiresAt })),
      };
    }
    const listed = await hostListEligibleLabels({ vars, provider: 'codex' });
    const coolingSet = new Set(listed.all.filter((l) => !listed.eligible.includes(l)));
    return { entries: [...coolingSet].map((label) => ({ label })) };
  } catch (err) {
    // Optional enrichment: the row keeps its last ledger and reports a stale cooling source.
    console.warn(`[providerAccounts.snapshot] cooling probe failed: ${(err as Error).message}`);
    return { failed: true };
  }
}

function unavailableRunners(
  status: ProviderRunnerAccountStatus['status'],
  error?: string,
): ProviderRunnerAccountStatus[] {
  return FLEET_SUBSCRIPTION_RUNNERS.map((runner) => ({
    runner,
    status,
    inventory: {
      status: 'unavailable',
      scope: 'host-default',
      accounts: [],
      error: 'Execution host unavailable',
    },
    activeLabel: null,
    ...(error ? { error } : { source: null }),
    usage: null,
  }));
}

async function sampleMachine(machine: string, slotId: string): Promise<ProviderSeatSample> {
  let vars: Awaited<ReturnType<typeof loadSlotVars>>;
  try {
    vars = await loadSlotVars(slotId);
  } catch (err) {
    return {
      hostUnavailable: true,
      runners: unavailableRunners('error', (err as Error).message).map(
        (row): ProviderSeatRunnerSample => ({
          row,
          identity: 'failed',
          quota: 'failed',
          ...(row.runner === 'codex' ? { cooling: 'failed' } : {}),
        }),
      ),
    };
  }

  const [subs, cooling] = await Promise.all([
    getHostRunnerSubscriptions(vars, { machineId: machine }),
    coolingForCodex(vars),
  ]);

  return {
    runners: subs.map((sub): ProviderSeatRunnerSample => {
      const status = statusFromSubscription(sub);
      const entries = 'entries' in cooling ? cooling.entries : undefined;
      return {
        row: {
          runner: sub.runner,
          ...(sub.inventory ? { inventory: sub.inventory } : {}),
          status,
          activeLabel: sub.accountLabel,
          source: sub.source,
          cooling: sub.runner === 'codex' && entries?.length ? entries : undefined,
          usage: usageFromSubscription(sub),
          ...(sub.error && status === 'error' ? { error: sub.error } : {}),
        },
        ...sub.outcome,
        ...(sub.runner === 'codex' ? { cooling: entries ? 'observed' : 'failed' } : {}),
      };
    }),
  };
}

let hasVisibleInterest: (machine: string) => boolean = () => false;
let notifyChanged: (machine: string) => void = () => {};
let activeObservation: object | undefined;

// Probing one machine can take ~20s (identity + CodexBar CLI invocations, plus
// remote hosts over SSH) — far past interactive request budgets. Legacy reads
// serve the last snapshot and refresh in the background; `forceRefresh` waits
// for (or joins) a live probe so a UI poll cannot stack CLI invocations.
const observation = new ProviderAccountObservation({
  topology: async () => {
    const fleet = await loadFleetStatus(false, true);
    const machines = new Map<string, string>();
    for (const slot of fleet.slots)
      if (!machines.has(slot.machine)) machines.set(slot.machine, slot.slot);
    return machines;
  },
  sample: sampleMachine,
  unknown: (machine) => ({
    machine,
    checkedAt: '',
    reachable: false,
    runners: unavailableRunners('unknown'),
  }),
  hasInterest: (machine) => hasVisibleInterest(machine),
  changed: (machine) => notifyChanged(machine),
});

/** Legacy reads keep their TTL; managed observers share per-machine work without renewing it. */
export function providerAccountsSnapshot(
  params: ProviderAccountsSnapshotParams = {},
  interest?: ProviderAccountsReadInterest,
): Promise<ProviderAccountsSnapshotResult> {
  return observation.read(params, params.forceRefresh === true, interest);
}

export function forgetProviderAccountsClientInterest(clientId: string): void {
  observation.forget(clientId);
}

export function wakeProviderAccountsObservation(): Promise<void> {
  return observation.tick();
}

/**
 * `hasInterest(machine)` is true while a reauthorized managed selector names the
 * machine or omits `machines` (all fleet machines). `changed(machine)` fires when
 * that machine's retained snapshot or source age changes, or it leaves the fleet.
 */
export function startProviderAccountsObservation(options: {
  hasInterest(machine: string): boolean;
  changed(machine: string): void;
}): () => Promise<void> {
  if (activeObservation) throw new Error('Provider account observation is already running');
  const owner = {};
  activeObservation = owner;
  hasVisibleInterest = options.hasInterest;
  notifyChanged = options.changed;
  observation.start();
  // Ticks check due owners each minute; each owner's attempts stay PROVIDER_ACCOUNTS_TTL_MS apart.
  const timer = setInterval(() => void observation.tick(), 60_000);
  timer.unref();
  return async () => {
    if (activeObservation !== owner) return;
    clearInterval(timer);
    hasVisibleInterest = () => false;
    await observation.stop();
    notifyChanged = () => {};
    if (activeObservation === owner) activeObservation = undefined;
  };
}
