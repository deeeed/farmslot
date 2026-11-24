import type { NativeSessionEvent } from '@farmslot/protocol';

/**
 * While a tool call is open the reviewer is waiting on it, not stuck: the silence allowed is this
 * many inactivity limits, still measured from the last progress, so a hung tool stays bounded.
 * Claude's longest Bash timeout equals the default inactivity limit (10 min); a tool that used
 * all of it lost the race by under a second (run 961d55d3).
 */
export const OPEN_TOOL_LIMIT_FACTOR = 3;

/** The events of one reviewer command that show it is working. */
export type ReviewerProgressEvent = Pick<NativeSessionEvent, 'type' | 'at' | 'nativeId'>;

/** A native reviewer's progress clock: tool starts and ends, and checklist marks. */
export class ReviewerProgressClock {
  lastProgressAt: number;
  observedProgress = false;
  private readonly openTools = new Set<string>();

  constructor(
    private startedAt: number,
    private readonly inactivityMs: number,
  ) {
    this.lastProgressAt = startedAt;
  }

  /** A newly accepted command starts its own clock; an earlier command's tools are not its own. */
  restart(at: number): void {
    if (at <= this.startedAt) return;
    this.startedAt = at;
    this.openTools.clear();
    if (this.lastProgressAt < at) {
      this.lastProgressAt = at;
      this.observedProgress = false;
    }
  }

  record(at: string): void {
    const timestamp = Date.parse(at);
    if (!Number.isFinite(timestamp) || timestamp < this.startedAt) return;
    this.observedProgress = true;
    this.lastProgressAt = Math.max(this.lastProgressAt, Math.min(Date.now(), timestamp));
  }

  /** Feed one event of the monitored command. */
  observe(event: ReviewerProgressEvent): void {
    if (event.type === 'tool.started' && event.nativeId) this.openTools.add(event.nativeId);
    else if (event.type === 'tool.completed' && event.nativeId)
      this.openTools.delete(event.nativeId);
    // Model output alone is not progress: a reviewer that only talks is still idle.
    if (event.type === 'tool.started' || event.type === 'tool.completed') this.record(event.at);
  }

  get toolOpen(): boolean {
    return this.openTools.size > 0;
  }

  get limitMs(): number {
    return this.toolOpen ? this.inactivityMs * OPEN_TOOL_LIMIT_FACTOR : this.inactivityMs;
  }

  silentMs(now = Date.now()): number {
    return now - this.lastProgressAt;
  }

  expired(now = Date.now()): boolean {
    return this.silentMs(now) >= this.limitMs;
  }

  /** Why the reviewer is being stopped, naming an open tool call when there is one. */
  failureMessage(now: number, reviewTimeoutMs: number): string {
    return this.toolOpen
      ? `Native reviewer tool call made no progress for ${this.silentMs(now)}ms ` +
          `(open-tool limit ${this.limitMs}ms; review budget ${reviewTimeoutMs}ms)`
      : `Native reviewer made no checklist or tool progress for ${this.silentMs(now)}ms ` +
          `(inactivity limit ${this.limitMs}ms; review budget ${reviewTimeoutMs}ms)`;
  }
}
