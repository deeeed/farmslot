/**
 * Provider subscription snapshot for fleet UI — per machine × runner.
 * Built via {@link getHostRunnerSubscriptions} on {@link RunnerStatusProvider}.
 */

import type {
  MachineProviderAccountsSnapshot,
  ProviderAccountsSnapshotParams,
  ProviderAccountsSnapshotResult,
  ProviderRunnerAccountStatus,
  ProviderRunnerUsageMirror,
} from '@farmslot/protocol';

import { loadSlotVars } from '../core/config.js';
import { isLocal } from '../core/exec.js';
import { loadFleetStatus } from '../fleet/state.js';
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
): Promise<ProviderRunnerAccountStatus['cooling']> {
  try {
    if (isLocal(vars.host, vars.machine)) {
      const ledger = loadExhaustionLedger();
      const now = Date.now();
      return Object.values(ledger.entries)
        .filter((e) => e.provider === 'codex' && Date.parse(e.expiresAt) > now)
        .map((e) => ({ label: e.label, tier: e.tier, expiresAt: e.expiresAt }));
    }
    const listed = await hostListEligibleLabels({ vars, provider: 'codex' });
    const coolingSet = new Set(listed.all.filter((l) => !listed.eligible.includes(l)));
    return [...coolingSet].map((label) => ({ label }));
  } catch (err) {
    // Optional enrichment for the Accounts panel — never fail the whole snapshot.
    console.warn(`[providerAccounts.snapshot] cooling probe failed: ${(err as Error).message}`);
    return undefined;
  }
}

async function snapshotMachine(
  machine: string,
  slotId: string | null,
): Promise<MachineProviderAccountsSnapshot> {
  const checkedAt = new Date().toISOString();
  if (!slotId) {
    return {
      machine,
      checkedAt,
      reachable: false,
      runners: FLEET_SUBSCRIPTION_RUNNERS.map((runner) => ({
        runner,
        status: runner === 'codex' ? 'unknown' : 'unsupported',
        activeLabel: null,
        source: null,
        usage: null,
      })),
    };
  }

  let vars: Awaited<ReturnType<typeof loadSlotVars>>;
  try {
    vars = await loadSlotVars(slotId);
  } catch (err) {
    return {
      machine,
      checkedAt,
      reachable: false,
      runners: FLEET_SUBSCRIPTION_RUNNERS.map((runner) => ({
        runner,
        status: 'error',
        activeLabel: null,
        error: (err as Error).message,
        usage: null,
      })),
    };
  }

  const [subs, cooling] = await Promise.all([
    getHostRunnerSubscriptions(vars, { machineId: machine }),
    coolingForCodex(vars),
  ]);

  const runners: ProviderRunnerAccountStatus[] = subs.map((sub) => ({
    runner: sub.runner,
    status: statusFromSubscription(sub),
    activeLabel: sub.accountLabel,
    source: sub.source,
    cooling: sub.runner === 'codex' && cooling?.length ? cooling : undefined,
    usage: usageFromSubscription(sub),
    ...(sub.error && statusFromSubscription(sub) === 'error' ? { error: sub.error } : {}),
  }));

  return {
    machine,
    checkedAt,
    reachable: true,
    runners,
  };
}

// Probing one machine can take ~20s (identity + CodexBar CLI invocations, plus
// remote hosts over SSH) — far past interactive request budgets. Serve the last
// snapshot immediately and refresh in the background; `forceRefresh` waits for
// a live probe (the operator's explicit Refresh). In-flight probes are deduped
// so a UI poll cannot stack CLI invocations on a slow host.
const SNAPSHOT_TTL_MS = 60_000;
const snapshotCache = new Map<string, MachineProviderAccountsSnapshot>();
const snapshotInflight = new Map<string, Promise<MachineProviderAccountsSnapshot>>();

function refreshMachineSnapshot(
  machine: string,
  slotId: string | null,
): Promise<MachineProviderAccountsSnapshot> {
  const running = snapshotInflight.get(machine);
  if (running) return running;
  const probe = snapshotMachine(machine, slotId)
    .then((snap) => {
      snapshotCache.set(machine, snap);
      return snap;
    })
    .finally(() => {
      snapshotInflight.delete(machine);
    });
  snapshotInflight.set(machine, probe);
  return probe;
}

async function snapshotMachineCached(
  machine: string,
  slotId: string | null,
  forceRefresh: boolean,
): Promise<MachineProviderAccountsSnapshot> {
  const cached = snapshotCache.get(machine);
  if (forceRefresh || !cached) return refreshMachineSnapshot(machine, slotId);
  const age = Date.now() - Date.parse(cached.checkedAt);
  if (Number.isNaN(age) || age > SNAPSHOT_TTL_MS) void refreshMachineSnapshot(machine, slotId);
  return cached;
}

export async function providerAccountsSnapshot(
  params: ProviderAccountsSnapshotParams = {},
): Promise<ProviderAccountsSnapshotResult> {
  const fleet = await loadFleetStatus();
  const byMachine = new Map<string, string | null>();
  for (const slot of fleet.slots) {
    if (!byMachine.has(slot.machine)) byMachine.set(slot.machine, slot.slot);
  }

  let machines = [...byMachine.keys()];
  if (params.machines?.length) {
    const want = new Set(params.machines);
    machines = [...want];
    for (const m of want) {
      if (!byMachine.has(m)) byMachine.set(m, null);
    }
  }

  const snapshots = await Promise.all(
    machines.map((machine) =>
      snapshotMachineCached(machine, byMachine.get(machine) ?? null, params.forceRefresh === true),
    ),
  );

  return {
    machines: snapshots,
    checkedAt: new Date().toISOString(),
  };
}
