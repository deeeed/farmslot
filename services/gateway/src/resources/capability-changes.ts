import { canonicalResourceJson } from '@farmslot/protocol/client-cache';

import type { RuntimeCapabilityStoreSnapshot } from '../runtime-capabilities/store.js';

import { GatewayResourceRevisions, resourceRevisions } from './revisions.js';

/** The durable registry owns lease/plan changes; file observers own catalog changes. */
export class CapabilityResourceChanges {
  private previous?: string;
  private slots = new Map<string, string>();
  private capabilities = new Map<string, string>();

  constructor(private readonly revisions: GatewayResourceRevisions = resourceRevisions) {}

  committed(snapshot: RuntimeCapabilityStoreSnapshot): void {
    const fingerprint = canonicalResourceJson({
      leases: snapshot.leases,
      proofPlans: snapshot.proofPlans,
      events: snapshot.events,
    });
    if (fingerprint === this.previous) return;
    this.previous = fingerprint;
    this.catalogChanged();
    const slots = new Map<string, unknown[]>();
    const capabilities = new Map<string, unknown[]>();
    const add = (groups: Map<string, unknown[]>, id: string, value: unknown) => {
      const group = groups.get(id) ?? [];
      group.push(value);
      groups.set(id, group);
    };
    for (const lease of snapshot.leases) {
      add(slots, lease.slotId, lease);
      add(capabilities, lease.capabilityId, lease);
    }
    for (const [ownerId, plan] of Object.entries(snapshot.proofPlans)) {
      add(slots, plan.slotId, { ownerId, plan });
      for (const requirement of plan.requirements)
        add(capabilities, requirement.capabilityId, { ownerId, slotId: plan.slotId, requirement });
    }
    for (const event of snapshot.events) {
      add(slots, event.slotId, event);
      add(capabilities, event.capabilityId, event);
    }
    this.slots = this.changedGroups(this.slots, slots, (slotId) =>
      this.revisions.advance({ family: 'capabilities', slotId }),
    );
    this.capabilities = this.changedGroups(this.capabilities, capabilities, (capabilityId) =>
      this.revisions.advance({ family: 'capability', capabilityId }),
    );
  }

  private changedGroups(
    previous: Map<string, string>,
    groups: Map<string, unknown[]>,
    changed: (id: string) => void,
  ): Map<string, string> {
    const current = new Map([...groups].map(([id, values]) => [id, canonicalResourceJson(values)]));
    for (const id of new Set([...previous.keys(), ...current.keys()]))
      if (previous.get(id) !== current.get(id)) changed(id);
    return current;
  }

  catalogChanged(): void {
    this.revisions.advance({ family: 'capabilities' });
  }
}

export const capabilityResourceChanges = new CapabilityResourceChanges();
