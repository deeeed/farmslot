import type { RunCIWatchPokeResult } from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';

export interface CIWatchPokeOutcome {
  ok: boolean;
  woken: boolean;
  message: string;
}

export interface CIWatchPokeViewState {
  poking: boolean;
  status: { ok: boolean; msg: string } | null;
}

const POKE_RESULT_TIMEOUT_MS = 30_000;
const POKE_STATUS_TTL_MS = 5_000;

export async function pokeCIWatchNow(runId: string): Promise<CIWatchPokeOutcome> {
  const result = (await gateway.request(Methods.RUN_CI_WATCH_POKE, {
    runId,
  })) as RunCIWatchPokeResult;
  return {
    ok: result.ok,
    woken: result.ok && result.woken,
    message: result.ok
      ? result.woken
        ? 'Woken — polling now'
        : 'No active poll to wake'
      : result.reason,
  };
}

export class CIWatchPokeController {
  private requestSeq = 0;
  private runId = '';
  private baselinePollCount: number | null = null;
  private resultTimer: number | null = null;
  private statusTimer: number | null = null;
  private state: CIWatchPokeViewState = { poking: false, status: null };

  constructor(private readonly onChange: (state: CIWatchPokeViewState) => void) {}

  async poke(runId: string, beforePollCount: number | null): Promise<void> {
    if (this.state.poking) return;
    const requestSeq = ++this.requestSeq;
    this.runId = runId;
    this.baselinePollCount = beforePollCount;
    this.setState({ poking: true, status: null });
    this.armResultTimeout();
    try {
      const result = await pokeCIWatchNow(runId);
      if (requestSeq !== this.requestSeq || runId !== this.runId) return;
      this.setStatus(result.ok, result.message);
      if (!result.ok || !result.woken || beforePollCount == null) this.finish();
    } catch (error) {
      if (requestSeq !== this.requestSeq || runId !== this.runId) return;
      this.setStatus(false, (error as Error).message || 'Check failed');
      this.finish();
    }
  }

  observePoll(runId: string, pollCount: number | null | undefined): void {
    if (
      !this.state.poking ||
      runId !== this.runId ||
      this.baselinePollCount == null ||
      typeof pollCount !== 'number' ||
      pollCount <= this.baselinePollCount
    ) {
      return;
    }
    this.finish();
  }

  reset(): void {
    this.requestSeq++;
    this.runId = '';
    this.baselinePollCount = null;
    this.clearResultTimer();
    this.clearStatusTimer();
    this.setState({ poking: false, status: null });
  }

  dispose(): void {
    this.reset();
  }

  private finish(): void {
    this.baselinePollCount = null;
    this.clearResultTimer();
    this.setState({ ...this.state, poking: false });
  }

  private setStatus(ok: boolean, msg: string): void {
    this.clearStatusTimer();
    this.setState({ ...this.state, status: { ok, msg } });
    this.statusTimer = window.setTimeout(() => {
      this.statusTimer = null;
      this.setState({ ...this.state, status: null });
    }, POKE_STATUS_TTL_MS);
  }

  private armResultTimeout(): void {
    this.clearResultTimer();
    this.resultTimer = window.setTimeout(() => {
      this.resultTimer = null;
      this.setStatus(false, 'Check did not report a new poll');
      this.finish();
    }, POKE_RESULT_TIMEOUT_MS);
  }

  private clearResultTimer(): void {
    if (this.resultTimer != null) window.clearTimeout(this.resultTimer);
    this.resultTimer = null;
  }

  private clearStatusTimer(): void {
    if (this.statusTimer != null) window.clearTimeout(this.statusTimer);
    this.statusTimer = null;
  }

  private setState(state: CIWatchPokeViewState): void {
    this.state = state;
    this.onChange(state);
  }
}
