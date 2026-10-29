import type {
  MachineProviderAccountsSnapshot,
  ProviderAccountsSnapshotParams,
  ProviderAccountsSnapshotResult,
  ProviderRunnerAccountStatus,
  ProviderRunnerUsageMirror,
  UpstreamObservation,
} from '@farmslot/protocol';

import type { RunnerComponentOutcome } from '../runners/status-provider.js';

/**
 * Legacy stale-while-revalidate age and the minimum gap between passive attempts. Each attempt
 * runs every runner's CLI probe on the machine, so an open fleet view samples slowly.
 */
export const PROVIDER_ACCOUNTS_TTL_MS = 5 * 60_000;
/** A due probe starts within one 60s tick and takes ~20s, so readiness outlasts one cycle. */
export const PROVIDER_ACCOUNTS_READY_MS = 7 * 60_000;
export const PROVIDER_ACCOUNTS_LEGACY_INTEREST_MS = 6 * 60_000;
const MAX_LEGACY_INTERESTS = 128;
const MAX_IDLE_MACHINES = 32;

export interface ProviderAccountsReadInterest {
  legacyClientId?: string;
  legacyInterest?: boolean;
}

export interface ProviderSeatRunnerSample {
  /** Live row from this attempt, including copy-only inspection and raw diagnostics. */
  row: ProviderRunnerAccountStatus;
  identity: RunnerComponentOutcome;
  quota: RunnerComponentOutcome;
  /** Only for runners whose host keeps a cooling ledger. */
  cooling?: RunnerComponentOutcome;
}

export interface ProviderSeatSample {
  /** The execution host could not be resolved; every component failed with it. */
  hostUnavailable?: boolean;
  runners: ProviderSeatRunnerSample[];
}

interface ObservationOptions {
  /** Machine -> slot used to reach it. Rejects when fleet state is unreadable. */
  topology(): Promise<Map<string, string>>;
  sample(machine: string, slotId: string): Promise<ProviderSeatSample>;
  /** Explicit row for a requested machine outside the fleet. */
  unknown(machine: string): MachineProviderAccountsSnapshot;
  hasInterest(machine: string): boolean;
  changed(machine: string): void;
  now?: () => number;
}

type Source = Pick<UpstreamObservation, 'observedAt' | 'error'>;

interface RunnerSeat {
  row: ProviderRunnerAccountStatus;
  identity: Source;
  quota: Source;
  cooling?: Source;
}

interface MachineSeats {
  machine: string;
  slotId: string;
  seats: RunnerSeat[];
  reachable: boolean;
  attemptedAt?: number;
  pending?: Promise<void>;
  retired?: boolean;
  published?: string;
  legacy: Map<string | symbol, number>;
}

const HOST_UNAVAILABLE = {
  code: 'PROVIDER_HOST_UNAVAILABLE',
  message: 'Execution host unavailable',
};

function settle(
  previous: Source | undefined,
  outcome: RunnerComponentOutcome,
  at: number,
  error: NonNullable<Source['error']>,
): Source {
  // Absence is a definitive answer; only a failed probe keeps the earlier success age.
  if (outcome !== 'failed') return { observedAt: at };
  return previous?.observedAt === undefined
    ? { error }
    : { observedAt: previous.observedAt, error };
}

function usage(
  identity: ProviderRunnerUsageMirror | null | undefined,
  quota: ProviderRunnerUsageMirror | null | undefined,
  error: string | undefined,
): ProviderRunnerUsageMirror | null {
  const merged = {
    accountEmail: identity?.accountEmail ?? null,
    remainingPercent: quota?.remainingPercent ?? null,
    usedPercent: quota?.usedPercent ?? null,
    resetsAt: quota?.resetsAt ?? null,
    loginMethod: identity?.loginMethod ?? null,
    source: identity?.source ?? null,
    ...(error ? { error } : {}),
  };
  return Object.entries(merged).some(([key, value]) => key !== 'source' && value != null)
    ? merged
    : null;
}

/** A failed component keeps its last successful fields; an independent success still lands. */
function merge(
  previous: RunnerSeat | undefined,
  sample: ProviderSeatRunnerSample,
  at: number,
  hostUnavailable: boolean,
): RunnerSeat {
  const { runner } = sample.row;
  const failure = (code: string, part: string) =>
    hostUnavailable ? HOST_UNAVAILABLE : { code, message: `${runner} ${part} unavailable` };
  const identity = settle(
    previous?.identity,
    sample.identity,
    at,
    failure('PROVIDER_IDENTITY_UNAVAILABLE', 'identity'),
  );
  const quota = settle(
    previous?.quota,
    sample.quota,
    at,
    failure('PROVIDER_QUOTA_UNAVAILABLE', 'usage'),
  );
  const cooling =
    sample.cooling &&
    settle(
      previous?.cooling,
      sample.cooling,
      at,
      failure('PROVIDER_COOLING_UNAVAILABLE', 'cooling'),
    );
  const keep = (outcome: RunnerComponentOutcome | undefined, source: Source | undefined) =>
    previous !== undefined && outcome === 'failed' && source?.observedAt !== undefined;
  const identityRow = keep(sample.identity, previous?.identity) ? previous!.row : sample.row;
  const quotaRow = keep(sample.quota, previous?.quota) ? previous!.row : sample.row;
  const coolingRow = keep(sample.cooling, previous?.cooling) ? previous!.row : sample.row;
  return {
    row: {
      ...identityRow,
      cooling: coolingRow.cooling,
      usage: usage(identityRow.usage, quotaRow.usage, sample.row.usage?.error),
    },
    identity,
    quota,
    ...(cooling ? { cooling } : {}),
  };
}

/** Ready only when every part is; otherwise the oldest known success, never an invented one. */
function conservative(parts: UpstreamObservation[]): UpstreamObservation {
  const known = parts.flatMap((part) => (part.observedAt === undefined ? [] : [part.observedAt]));
  const error = parts.find((part) => part.error)?.error;
  if (parts.length && parts.every((part) => part.status === 'ready'))
    return { status: 'ready', observedAt: Math.min(...known) };
  if (!known.length) return { status: 'error', error: error ?? HOST_UNAVAILABLE };
  return { status: 'stale', observedAt: Math.min(...known), ...(error ? { error } : {}) };
}

function iso(at: number | undefined): string {
  return at === undefined ? '' : new Date(at).toISOString();
}

/** One bounded owner per machine, shared by every selector that names or spans it. */
export class ProviderAccountObservation {
  private readonly machines = new Map<string, MachineSeats>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly anonymousLegacyClient = Symbol('legacy-provider-accounts-reader');
  private stopped = false;
  private readonly now: () => number;

  constructor(private readonly options: ObservationOptions) {
    this.now = options.now ?? Date.now;
  }

  async read(
    params: ProviderAccountsSnapshotParams = {},
    force = false,
    interest: ProviderAccountsReadInterest = {},
  ): Promise<ProviderAccountsSnapshotResult> {
    const topology = await this.topology();
    const known = topology ?? this.knownTopology();
    const requested = params.machines?.length ? [...new Set(params.machines)] : [...known.keys()];
    const legacy = interest.legacyInterest !== false;
    const machines = await Promise.all(
      requested.map(async (machine) => {
        const slotId = known.get(machine);
        const seats = slotId === undefined ? undefined : this.owner(machine, slotId);
        if (!seats)
          return {
            ...this.options.unknown(machine),
            observation: {
              status: 'error' as const,
              error: { code: 'PROVIDER_MACHINE_UNKNOWN', message: 'Machine is not in the fleet' },
            },
          };
        if (!this.stopped) {
          if (legacy) this.touch(seats, interest.legacyClientId ?? this.anonymousLegacyClient);
          else if (interest.legacyClientId !== undefined)
            seats.legacy.delete(interest.legacyClientId);
          // Managed warm reads never probe. Legacy readers keep stale-while-revalidate.
          if (force || seats.attemptedAt === undefined) await this.refresh(seats);
          else if (legacy && this.due(seats)) void this.refresh(seats);
        }
        return this.snapshot(seats);
      }),
    );
    const observation = machines.length
      ? conservative(machines.map((machine) => machine.observation!))
      : topology
        ? // A readable empty fleet is a definitive absence.
          { status: 'ready' as const, observedAt: this.now() }
        : {
            status: 'error' as const,
            error: { code: 'PROVIDER_FLEET_UNAVAILABLE', message: 'Fleet state unavailable' },
          };
    return { machines, checkedAt: iso(observation.observedAt), observation };
  }

  forget(clientId: string): void {
    for (const seats of this.machines.values()) seats.legacy.delete(clientId);
  }

  start(): void {
    this.stopped = false;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const seats of this.machines.values()) seats.legacy.clear();
    await Promise.all(this.inFlight);
  }

  /** Called by the owning service's minute timer or a newly admitted visible observer. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    const topology = (await this.topology()) ?? this.knownTopology();
    const active = new Set<string>();
    const work: Promise<void>[] = [];
    for (const [machine, slotId] of topology) {
      const existing = this.machines.get(machine);
      if (existing) this.publish(existing);
      if (!(existing && this.hasLegacyInterest(existing)) && !this.options.hasInterest(machine))
        continue;
      active.add(machine);
      const seats = existing ?? this.owner(machine, slotId);
      if (this.due(seats)) work.push(this.refresh(seats));
    }
    // Bound retained owners nobody observes; active and in-flight owners stay.
    const idle = [...this.machines.values()].filter(
      (seats) => !seats.pending && !active.has(seats.machine),
    );
    for (const seats of idle.slice(0, Math.max(0, idle.length - MAX_IDLE_MACHINES)))
      this.machines.delete(seats.machine);
    await Promise.all(work);
  }

  private async topology(): Promise<Map<string, string> | undefined> {
    let topology: Map<string, string>;
    try {
      topology = await this.options.topology();
    } catch {
      // Unreadable fleet state is not a topology change; keep the current owners.
      return undefined;
    }
    for (const [machine, seats] of this.machines) {
      const slotId = topology.get(machine);
      if (slotId !== undefined) {
        seats.slotId = slotId;
        continue;
      }
      // In-flight work drains through stop(); its completion can no longer publish.
      this.machines.delete(machine);
      seats.retired = true;
      if (!this.stopped && seats.published !== undefined) this.options.changed(machine);
    }
    return topology;
  }

  private knownTopology(): Map<string, string> {
    return new Map([...this.machines].map(([machine, seats]) => [machine, seats.slotId]));
  }

  private owner(machine: string, slotId: string): MachineSeats {
    let seats = this.machines.get(machine);
    if (!seats) {
      seats = { machine, slotId, seats: [], reachable: true, legacy: new Map() };
      this.machines.set(machine, seats);
    }
    return seats;
  }

  private touch(seats: MachineSeats, client: string | symbol): void {
    seats.legacy.delete(client);
    seats.legacy.set(client, this.now());
    if (seats.legacy.size > MAX_LEGACY_INTERESTS)
      seats.legacy.delete(seats.legacy.keys().next().value!);
  }

  private hasLegacyInterest(seats: MachineSeats): boolean {
    for (const [client, at] of seats.legacy)
      if (this.now() - at >= PROVIDER_ACCOUNTS_LEGACY_INTEREST_MS) seats.legacy.delete(client);
    return seats.legacy.size > 0;
  }

  private due(seats: MachineSeats): boolean {
    return (
      seats.attemptedAt === undefined || this.now() - seats.attemptedAt >= PROVIDER_ACCOUNTS_TTL_MS
    );
  }

  /** Explicit force and cold reads join the in-flight probe rather than stacking CLIs. */
  private refresh(seats: MachineSeats): Promise<void> {
    if (this.stopped || seats.retired) return Promise.resolve();
    if (seats.pending) return seats.pending;
    const pending = (async () => {
      let sample: ProviderSeatSample;
      try {
        sample = await this.options.sample(seats.machine, seats.slotId);
      } catch {
        sample = {
          hostUnavailable: true,
          runners: seats.seats.map(
            (seat): ProviderSeatRunnerSample => ({
              row: seat.row,
              identity: 'failed',
              quota: 'failed',
              ...(seat.cooling ? { cooling: 'failed' } : {}),
            }),
          ),
        };
      }
      // Source success is this completion, not the read or probe start.
      const at = this.now();
      const previous = new Map(seats.seats.map((seat) => [seat.row.runner, seat]));
      seats.seats = sample.runners.map((runner) =>
        merge(previous.get(runner.row.runner), runner, at, sample.hostUnavailable === true),
      );
      seats.reachable = sample.hostUnavailable !== true;
      seats.attemptedAt = at;
      this.publish(seats);
    })().finally(() => {
      seats.pending = undefined;
      this.inFlight.delete(pending);
    });
    seats.pending = pending;
    this.inFlight.add(pending);
    return pending;
  }

  private snapshot(seats: MachineSeats): MachineProviderAccountsSnapshot {
    const now = this.now();
    const observe = (source: Source): UpstreamObservation => ({
      status: source.error
        ? source.observedAt === undefined
          ? 'error'
          : 'stale'
        : now - source.observedAt! >= PROVIDER_ACCOUNTS_READY_MS
          ? 'stale'
          : 'ready',
      ...(source.observedAt === undefined ? {} : { observedAt: source.observedAt }),
      ...(source.error ? { error: source.error } : {}),
    });
    const runners = seats.seats.map((seat) => ({
      ...seat.row,
      observations: {
        identity: observe(seat.identity),
        quota: observe(seat.quota),
        ...(seat.cooling ? { cooling: observe(seat.cooling) } : {}),
      },
    }));
    const observation = conservative(
      runners.flatMap(({ observations }) => Object.values(observations)),
    );
    return {
      machine: seats.machine,
      checkedAt: iso(observation.observedAt ?? seats.attemptedAt),
      reachable: seats.reachable,
      runners,
      observation,
    };
  }

  private publish(seats: MachineSeats): void {
    if (this.stopped || seats.retired || seats.attemptedAt === undefined) return;
    const signature = JSON.stringify(this.snapshot(seats));
    if (signature === seats.published) return;
    seats.published = signature;
    this.options.changed(seats.machine);
  }
}
