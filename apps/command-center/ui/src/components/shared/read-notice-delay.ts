import type { ProgressReadNotice } from '../../utils/progress-read-status.js';

export const AVAILABLE_AFTER_REFRESH = 'Available after refresh';

/** One event-driven grace period for transient read notices. Real failures persist during retry. */
export class ReadNoticeDelay {
  visible?: ProgressReadNotice;
  private latest?: ProgressReadNotice;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly changed: () => void) {}

  update(notice?: ProgressReadNotice): void {
    this.latest = notice;
    if (!notice) {
      this.clear();
    } else if (notice.kind === 'error') {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.visible = notice;
    } else if (this.visible?.kind === 'error') {
      // Retain a real failure while its retry is in flight; success clears it.
      return;
    } else if (this.visible) {
      this.visible = notice;
    } else if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.visible = this.latest;
        this.changed();
      }, 1000);
    }
  }

  clear(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.latest = undefined;
    this.visible = undefined;
  }
}
