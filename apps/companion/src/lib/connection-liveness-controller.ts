import { nextConnectionProbeDelay } from './connection-liveness';

export type ProbeOutcome = { ok: true } | { ok: false };

interface ConnectionLivenessControllerOptions {
  probe: () => Promise<ProbeOutcome>;
  onForeground: () => void;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export class ConnectionLivenessController {
  private readonly probe: () => Promise<ProbeOutcome>;
  private readonly onForeground: () => void;
  private readonly setTimer: NonNullable<ConnectionLivenessControllerOptions['setTimer']>;
  private readonly clearTimer: NonNullable<ConnectionLivenessControllerOptions['clearTimer']>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<ProbeOutcome> | null = null;
  private active = false;
  private consecutiveFailures = 0;

  constructor(options: ConnectionLivenessControllerOptions) {
    this.probe = options.probe;
    this.onForeground = options.onForeground;
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

  probeNow(): Promise<ProbeOutcome> {
    if (!this.active) return Promise.resolve({ ok: false });
    this.cancelTimer();
    if (this.inFlight) return this.inFlight;

    const probe = this.probe().then(
      (outcome) => {
        this.consecutiveFailures = outcome.ok ? 0 : this.consecutiveFailures + 1;
        return outcome;
      },
      (error: unknown) => {
        this.consecutiveFailures += 1;
        throw error;
      },
    );

    this.inFlight = probe.finally(() => {
      this.inFlight = null;
      if (this.active) {
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
    return this.probeNow();
  }

  stop(): void {
    this.active = false;
    this.cancelTimer();
  }

  private cancelTimer(): void {
    if (!this.timer) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }
}
