export interface VerticalSplitPercentInput {
  startPct: number;
  startY: number;
  currentY: number;
  containerHeight: number;
  minPct?: number;
  maxPct?: number;
}

export function verticalSplitPercent({
  startPct,
  startY,
  currentY,
  containerHeight,
  minPct = 15,
  maxPct = 85,
}: VerticalSplitPercentInput): number {
  if (containerHeight === 0) return startPct;
  const deltaPct = ((currentY - startY) / containerHeight) * 100;
  return Math.max(minPct, Math.min(maxPct, startPct + deltaPct));
}

export interface VerticalSplitResizerOptions {
  getSplitPct: () => number;
  setSplitPct: (next: number) => void;
  getContainer: () => HTMLElement | null;
  minPct?: number;
  maxPct?: number;
}

export class VerticalSplitResizer {
  private resizing = false;
  private startY = 0;
  private startPct = 0;

  constructor(private readonly options: VerticalSplitResizerOptions) {}

  readonly start = (event: MouseEvent): void => {
    event.preventDefault();
    this.resizing = true;
    this.startY = event.clientY;
    this.startPct = this.options.getSplitPct();
    document.addEventListener('mousemove', this.move);
    document.addEventListener('mouseup', this.end);
  };

  disconnect(): void {
    this.end();
  }

  private readonly move = (event: MouseEvent): void => {
    if (!this.resizing) return;
    const container = this.options.getContainer();
    if (!container || container.clientHeight === 0) return;
    this.options.setSplitPct(
      verticalSplitPercent({
        startPct: this.startPct,
        startY: this.startY,
        currentY: event.clientY,
        containerHeight: container.clientHeight,
        minPct: this.options.minPct,
        maxPct: this.options.maxPct,
      }),
    );
  };

  private readonly end = (): void => {
    this.resizing = false;
    document.removeEventListener('mousemove', this.move);
    document.removeEventListener('mouseup', this.end);
  };
}
