import { setTimeout as delay } from 'node:timers/promises';

export type LaunchProbeName = 'code' | 'toolchain' | 'leftovers';

export interface LaunchProbeResult {
  status: 'verified' | 'mismatch' | 'unverified';
  detail: string;
}

export interface LaunchProbeTiming {
  budgetMs: number;
  retryWaitMs: number;
}

// Loaded-host and remote-host samples in #1509. Budget = p95 + max(p95, 5s), rounded up.
export const LAUNCH_PROBE_TIMING: Readonly<Record<LaunchProbeName, LaunchProbeTiming>> = {
  code: { budgetMs: 12_000, retryWaitMs: 5_609 },
  toolchain: { budgetMs: 16_000, retryWaitMs: 7_841 },
  leftovers: { budgetMs: 41_000, retryWaitMs: 20_245 },
};

export interface LaunchProbe {
  name: LaunchProbeName;
  inspect(signal: AbortSignal, budgetMs: number): Promise<LaunchProbeResult>;
}

export interface LaunchPreflightOptions {
  assertCurrent(): void | Promise<void>;
  record(
    name: LaunchProbeName,
    result: LaunchProbeResult,
    attempts: number,
    elapsedMs: number,
  ): void;
  timing?: Readonly<Record<LaunchProbeName, LaunchProbeTiming>>;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  /** Injectable deadlines let tests exercise slow hosts without real waits. */
  deadline?: (ms: number, expire: () => void) => () => void;
}

export class LaunchPreflightRefusal extends Error {
  constructor(
    readonly probe: LaunchProbeName,
    detail: string,
  ) {
    super(`Worker launch preflight ${probe}: ${detail}`);
    this.name = 'LaunchPreflightRefusal';
  }
}

async function inspectBounded(
  probe: LaunchProbe,
  timing: LaunchProbeTiming,
  deadline: NonNullable<LaunchPreflightOptions['deadline']>,
): Promise<LaunchProbeResult> {
  const abort = new AbortController();
  let dispose: () => void = () => {};
  const expired = new Promise<LaunchProbeResult>((resolve) => {
    dispose = deadline(timing.budgetMs, () => {
      abort.abort();
      resolve({ status: 'unverified', detail: `probe timed out after ${timing.budgetMs}ms` });
    });
  });
  // An unavailable read is explicitly unverified. It cannot grant cleanup or ownership authority.
  const inspected = Promise.resolve()
    .then(() => probe.inspect(abort.signal, timing.budgetMs))
    .catch(
      (error: unknown): LaunchProbeResult => ({
        status: 'unverified',
        detail: error instanceof Error ? error.message : String(error),
      }),
    );
  try {
    return await Promise.race([inspected, expired]);
  } finally {
    dispose();
  }
}

/** Shared read-only launch gate. Cleanup remains with the replay/lifecycle owner. */
export async function runLaunchPreflight(
  probes: readonly LaunchProbe[],
  options: LaunchPreflightOptions,
): Promise<void> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((ms) => delay(ms));
  const deadline =
    options.deadline ??
    ((ms, expire) => {
      const timer = setTimeout(expire, ms);
      return () => clearTimeout(timer);
    });
  for (const probe of probes) {
    const timing = (options.timing ?? LAUNCH_PROBE_TIMING)[probe.name];
    const started = now();
    await options.assertCurrent();
    let result = await inspectBounded(probe, timing, deadline);
    await options.assertCurrent();
    let attempts = 1;
    if (result.status === 'unverified') {
      options.record(probe.name, result, attempts, now() - started);
      await wait(timing.retryWaitMs);
      await options.assertCurrent();
      result = await inspectBounded(probe, timing, deadline);
      attempts++;
      await options.assertCurrent();
    }
    options.record(probe.name, result, attempts, now() - started);
    if (result.status === 'mismatch') throw new LaunchPreflightRefusal(probe.name, result.detail);
  }
  await options.assertCurrent();
}
