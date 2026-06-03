import { create } from 'zustand';

import type { FleetStatus, SlotStatus } from '@farmslot/protocol';

interface FleetStore {
  fleet: FleetStatus | null;
  loading: boolean;
  setFleet: (fleet: FleetStatus) => void;
  updateSlot: (slot: SlotStatus) => void;
  setLoading: (loading: boolean) => void;
}

export const useFleetStore = create<FleetStore>((set, get) => ({
  fleet: null,
  loading: false,

  setFleet: (fleet) => set({ fleet, loading: false }),

  updateSlot: (updatedSlot) => {
    const { fleet } = get();
    if (!fleet) return;
    const slots = fleet.slots.map((s) => (s.slot === updatedSlot.slot ? updatedSlot : s));
    set({ fleet: { ...fleet, slots } });
  },

  setLoading: (loading) => set({ loading }),
}));
