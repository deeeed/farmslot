import type { RunDecision } from '@farmslot/protocol';

type Resolution = Pick<RunDecision, 'resolvedAt' | 'resolvedAction'>;

/** Retain settled gate display metadata. Replay supersession can still roll back. */
export class RunDisplayResolutions {
  private scope?: string;
  private readonly resolved = new Map<string, Resolution>();

  read(scope: string | undefined, decisions: RunDecision[]): RunDecision[] {
    if (scope !== this.scope) {
      this.scope = scope;
      this.resolved.clear();
    }
    if (!scope) return decisions;
    let retained = false;
    const displayed = decisions.map((decision) => {
      if (decision.payload?.kind !== 'ready' || decision.resolvedAction === 'superseded') {
        this.resolved.delete(decision.id);
        return decision;
      }
      if (decision.resolvedAt) {
        this.resolved.set(decision.id, {
          resolvedAt: decision.resolvedAt,
          resolvedAction: decision.resolvedAction,
        });
        return decision;
      }
      const resolution = this.resolved.get(decision.id);
      if (!resolution) return decision;
      retained = true;
      return { ...decision, ...resolution };
    });
    return retained ? displayed : decisions;
  }
}
