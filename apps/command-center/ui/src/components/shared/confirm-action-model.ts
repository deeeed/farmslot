type ConfirmTimer = ReturnType<typeof setTimeout> | undefined;

export interface ConfirmActionTimerOptions {
  pendingConfirm: () => string | null;
  setPendingConfirm: (pending: string | null) => void;
}

export class ConfirmActionTimer {
  private timer: ConfirmTimer;

  constructor(private readonly options: ConfirmActionTimerOptions) {}

  confirm(actionId: string, execute: () => void, timeoutMs = 3000): void {
    if (this.options.pendingConfirm() === actionId) {
      this.clear();
      execute();
      return;
    }

    clearTimeout(this.timer);
    this.options.setPendingConfirm(actionId);
    this.timer = setTimeout(() => {
      this.options.setPendingConfirm(null);
    }, timeoutMs);
  }

  clear(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.options.setPendingConfirm(null);
  }
}
