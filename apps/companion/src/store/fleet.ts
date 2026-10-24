import { create } from 'zustand';

import type { FleetStatus, FleetStatusResult } from '@farmslot/protocol';
import type { ResourceQueryState } from '@farmslot/protocol/client-cache';

interface FleetStore {
  fleet: FleetStatus | null;
  observation: ResourceQueryState<FleetStatusResult>;
  loading: boolean;
  setFleet: (fleet: FleetStatus) => void;
}

export const useFleetStore = create<FleetStore>((set) => ({
  fleet: null,
  observation: { status: 'loading' },
  loading: false,

  setFleet: (fleet) => set({ fleet, loading: false }),
}));
