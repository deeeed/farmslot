type CopyFeedbackTimerHandle = ReturnType<typeof setTimeout> | undefined;

export interface CopyFeedbackTimerOptions {
  copiedKey: () => string;
  setCopiedKey: (key: string) => void;
}

export class CopyFeedbackTimer {
  private timer: CopyFeedbackTimerHandle;

  constructor(private readonly options: CopyFeedbackTimerOptions) {}

  show(key: string, timeoutMs = 1500): void {
    clearTimeout(this.timer);
    this.options.setCopiedKey(key);
    this.timer = setTimeout(() => {
      if (this.options.copiedKey() === key) {
        this.options.setCopiedKey('');
      }
      this.timer = undefined;
    }, timeoutMs);
  }

  clear(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.options.setCopiedKey('');
  }
}
