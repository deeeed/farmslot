import { nextConnectionProbeDelay } from './connection-liveness';

export type ProbeOutcome = { ok: true; latencyMs?: number } | { ok: false; error?: string };

interface ConnectionLivenessControllerOptions {
  probe: () => Promise<ProbeOutcome>;
  onForeground: () => void;
  onProbeError: (error: unknown) => void;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export class ConnectionLivenessController {
  private readonly probe: () => Promise<ProbeOutcome>;
  private readonly onForeground: () => void;
  private readonly onProbeError: (error: unknown) => void;
  private readonly setTimer: NonNullable<ConnectionLivenessControllerOptions['setTimer']>;
  private readonly clearTimer: NonNullable<ConnectionLivenessControllerOptions['clearTimer']>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<ProbeOutcome> | null = null;
  private active = false;
  private consecutiveFailures = 0;
  private generation = 0;

  constructor(options: ConnectionLivenessControllerOptions) {
    this.probe = options.probe;
    this.onForeground = options.onForeground;
    this.onProbeError = options.onProbeError;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  setAppActive(active: boolean): void {
    if (!active) {
      this.active = false;
      this.cancelTimer();
      return;
    }

    const returningToForeground = !this.active;
    this.active = true;
    if (returningToForeground) {
      this.onForeground();
      void this.probeNow();
    }
  }

  probeNow(allowInactive = false): Promise<ProbeOutcome> {
    if (!this.active && !allowInactive) return Promise.resolve({ ok: false });
    this.cancelTimer();
    if (this.inFlight) return this.inFlight;

    const generation = this.generation;
    const probe = this.probe().then(
      (outcome) => {
        if (generation === this.generation) {
          this.consecutiveFailures = outcome.ok ? 0 : this.consecutiveFailures + 1;
        }
        return outcome;
      },
      (error: unknown) => {
        if (generation === this.generation) {
          this.consecutiveFailures += 1;
          this.onProbeError(error);
        }
        return { ok: false } as const;
      },
    );

    this.inFlight = probe.finally(() => {
      this.inFlight = null;
      if (this.active && generation === this.generation) {
        this.timer = this.setTimer(
          () => void this.probeNow(),
          nextConnectionProbeDelay(this.consecutiveFailures),
        );
      }
    });
    return this.inFlight;
  }

  async probeFresh(): Promise<ProbeOutcome> {
    if (this.inFlight) await this.inFlight;
    return this.probeNow(true);
  }

  reset(): void {
    this.generation += 1;
    this.consecutiveFailures = 0;
    this.cancelTimer();
  }

  stop(): void {
    this.active = false;
    this.generation += 1;
    this.cancelTimer();
  }

  private cancelTimer(): void {
    if (!this.timer) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }
}
