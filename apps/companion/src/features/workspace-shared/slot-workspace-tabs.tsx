import { createContext, type ReactNode, useContext } from 'react';

const SlotWorkspaceTabsContext = createContext(false);

export function SlotWorkspaceTabsProvider({ children }: { children: ReactNode }) {
  return (
    <SlotWorkspaceTabsContext.Provider value={true}>{children}</SlotWorkspaceTabsContext.Provider>
  );
}

export function useSlotWorkspaceTabs(): boolean {
  return useContext(SlotWorkspaceTabsContext);
}
