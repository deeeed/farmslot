import { GATEWAY_COMMAND_METHODS } from '../client-cache/command-method.js';
import { Methods } from '../rpc/registry.js';

import { PerformanceRecorder } from './recorder.js';
import type { ClientPerformanceReportResult, PerformanceActionClass } from './types.js';
const commands = new Set<string>(GATEWAY_COMMAND_METHODS);
export function performanceActionClass(method: string): PerformanceActionClass {
  return commands.has(method) ? 'gate-action' : 'interactive-read';
}
export function isPerformanceMethod(method: string): boolean {
  return (
    method === Methods.GATEWAY_PERFORMANCE_GET || method === Methods.GATEWAY_PERFORMANCE_REPORT
  );
}
export class PerformanceReporter {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private timerEpoch = 0;
  private readonly stopActivity: () => void;
  constructor(
    private metrics: PerformanceRecorder,
    private ready: () => boolean,
    private send: (report: unknown) => Promise<ClientPerformanceReportResult>,
  ) {
    this.stopActivity = metrics.onActivity(() => this.schedule());
  }
  schedule(): void {
    if (this.timer && this.timerEpoch !== this.metrics.epoch) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.disposed || this.timer || !this.ready()) return;
    this.timerEpoch = this.metrics.epoch;
    const epoch = this.metrics.epoch;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.ready() || epoch !== this.metrics.epoch) return;
      void this.flush();
    }, 30000);
    // Node-based CLI/tests do not stay alive for a telemetry flush.
    if (typeof this.timer === 'object' && 'unref' in this.timer) this.timer.unref();
  }
  private async flush(): Promise<void> {
    const epoch = this.metrics.epoch,
      report = this.metrics.beginReport();
    if (!report) return;
    try {
      const result = await this.send(report);
      if (epoch !== this.metrics.epoch) return;
      if (result.accepted) this.metrics.acknowledge(report.sequence);
      else this.metrics.expireReportSource();
    } catch {
      // Preserve the identical chunk for an idempotent retry after a lost response.
      if (epoch === this.metrics.epoch)
        this.metrics.increment('farmslot_client_report_failures_total', {});
    }
    if (epoch === this.metrics.epoch) this.schedule();
  }
  dispose(): void {
    this.disposed = true;
    this.stopActivity();
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
