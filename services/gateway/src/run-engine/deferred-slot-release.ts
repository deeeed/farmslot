import type { SlotReleaseParams } from '@farmslot/protocol';

/** A retiring engine loop cannot overwrite or consume its successor's teardown. */
export class DeferredSlotReleases {
  private readonly releases = new Map<string, { generation: number; params: SlotReleaseParams }>();

  constructor(private readonly isCurrent: (runId: string, generation: number) => boolean) {}

  defer(runId: string, generation: number, params: SlotReleaseParams): void {
    if (!this.isCurrent(runId, generation)) return;
    this.releases.set(runId, { generation, params });
  }

  take(runId: string, generation: number): SlotReleaseParams | undefined {
    const release = this.releases.get(runId);
    if (!release || release.generation !== generation) return undefined;
    this.releases.delete(runId);
    return release.params;
  }
}
