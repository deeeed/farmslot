import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';

import type { CompanionViewLocation } from '@farmslot/protocol/surfaces/view-links';

import type { QuickVoiceTarget } from '../../lib/quick-actions';

export interface VoiceTarget extends QuickVoiceTarget {
  owner: symbol;
  routeKey: string;
  invoke(context?: string): void;
}

export interface ViewSelection {
  owner: symbol;
  scope: string;
  location: CompanionViewLocation;
  ownerPath: string;
}

export interface ComposerInset {
  owner: symbol;
  scope: string;
  routeKey: string;
  height: number;
}

interface QuickActionsContextValue {
  scope: string;
  routeKey: string;
  currentRoute: CompanionViewLocation;
  voiceTarget: VoiceTarget | null;
  composerInset: ComposerInset | null;
  registerComposerInset(inset: Omit<ComposerInset, 'owner'>): () => void;
  viewSelection: ViewSelection | null;
  registerVoice(target: Omit<VoiceTarget, 'owner'>): () => void;
  registerView(location: CompanionViewLocation, scope: string, ownerPath: string): () => void;
  requestVoice(key: string, context: string): void;
  beginCopilotVoice(context: string): void;
  handoffPending: boolean;
  activeOutlet: symbol | null;
  registerOutlet(owner: symbol): () => void;
}

/**
 * The provider's value behind a subscription. It changes on every navigation, and as a context
 * value each change made React walk every mounted screen looking for readers; a store re-renders
 * only the components that read the changed value.
 */
export interface QuickActionsStore {
  get(): QuickActionsContextValue;
  set(value: QuickActionsContextValue): void;
  subscribe(listener: () => void): () => void;
}

export function createQuickActionsStore(initial: QuickActionsContextValue): QuickActionsStore {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      if (next === value) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const QuickActionsContext = createContext<QuickActionsStore | null>(null);

const noStore = { get: () => null, subscribe: () => () => {} };

export function useQuickActions() {
  const context = useOptionalQuickActions();
  if (!context) throw new Error('Quick actions require their root provider.');
  return context;
}
export function useOptionalQuickActions(): QuickActionsContextValue | null {
  const store = useContext(QuickActionsContext) ?? noStore;
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
/** One field, so a screen re-renders only when that field changes. */
export function useQuickActionsField<K extends keyof QuickActionsContextValue>(
  key: K,
): QuickActionsContextValue[K] | undefined {
  const store = useContext(QuickActionsContext) ?? noStore;
  const read = useCallback(() => store.get()?.[key], [store, key]);
  return useSyncExternalStore(store.subscribe, read, read);
}
