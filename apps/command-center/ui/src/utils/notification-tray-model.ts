import type { PendingDecision } from '@farmslot/protocol';

export interface TrayItem {
  id: string;
  title: string;
  body: string;
  route: string;
  needsYou: boolean;
  current: boolean;
  observedAt?: number;
  view?: 'update';
  retry?: () => void;
}
type DecisionNotice = Pick<
  PendingDecision,
  'id' | 'type' | 'title' | 'description' | 'slotId' | 'runMeta'
>;

/** Current conditions only. No persistence, timers or command dispatch. */
export class NotificationTrayModel {
  private owner?: string;
  private sources = new Map<object | string, TrayItem[]>();
  private decisionKeys = new Set<string>();
  private decisionsReady = false;
  private listeners = new Set<() => void>();
  constructor(private readonly alert: (item: TrayItem) => void) {}
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  setOwner(owner?: string): void {
    if (owner === this.owner) return;
    this.owner = owner;
    this.sources.clear();
    this.decisionKeys.clear();
    this.decisionsReady = false;
    this.changed();
  }
  set(source: object | string, owner: string | undefined, items: TrayItem[]): void {
    if (!owner || owner !== this.owner) return;
    if (items.length) this.sources.set(source, items);
    else this.sources.delete(source);
    this.changed();
  }
  clear(source: object | string): void {
    if (this.sources.delete(source)) this.changed();
  }
  decisions(
    owner: string | undefined,
    decisions: readonly DecisionNotice[],
    current: boolean,
  ): void {
    if (!owner || owner !== this.owner) return;
    const grouped = new Map<string, TrayItem>();
    for (const decision of decisions) {
      const runId = decision.runMeta?.runId;
      const id = runId
        ? `run:${runId}:decision`
        : decision.slotId
          ? `slot:${decision.slotId}:${decision.type}`
          : `decision:${decision.id}`;
      if (grouped.has(id)) continue;
      grouped.set(id, {
        id,
        title: decision.title,
        body: decision.description,
        route: runId
          ? `#run/${encodeURIComponent(runId)}`
          : decision.slotId
            ? `#slot/${encodeURIComponent(decision.slotId)}`
            : '#decisions',
        needsYou: true,
        current,
      });
    }
    if (current) {
      if (this.decisionsReady)
        for (const [id, item] of grouped) if (!this.decisionKeys.has(id)) this.alert(item);
      this.decisionsReady = true;
      this.decisionKeys = new Set(grouped.keys());
    }
    this.set('decisions', owner, [...grouped.values()]);
  }
  get items(): TrayItem[] {
    const items = new Map<string, TrayItem>();
    for (const group of this.sources.values())
      for (const item of group) {
        const prior = items.get(item.id);
        if (!prior || item.current || !prior.current) items.set(item.id, item);
      }
    return [...items.values()].sort(
      (a, b) =>
        Number(b.needsYou && b.current) - Number(a.needsYou && a.current) ||
        a.id.localeCompare(b.id),
    );
  }
  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}
