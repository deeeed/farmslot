import { createContext, useContext } from 'react';

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

export const QuickActionsContext = createContext<QuickActionsContextValue | null>(null);

export function useQuickActions() {
  const context = useContext(QuickActionsContext);
  if (!context) throw new Error('Quick actions require their root provider.');
  return context;
}
export function useOptionalQuickActions() {
  return useContext(QuickActionsContext);
}
