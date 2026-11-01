import { useFocusEffect, useGlobalSearchParams, usePathname } from 'expo-router';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { CompanionViewLocation } from '@farmslot/protocol/surfaces/view-links';

import { quickVoiceMayStart, quickVoiceWorkerKey } from '../../lib/quick-actions';
import { tmuxWorkerRefFromRouteParams } from '../../lib/tmux-workers';
import { useConnectionStore } from '../../store/connection';

import { CopilotVoiceHandoff } from './CopilotVoiceHandoff';
import {
  type ComposerInset,
  createQuickActionsStore,
  QuickActionsContext,
  useQuickActionsField,
  type ViewSelection,
  type VoiceTarget,
} from './quick-actions-context';
export { useQuickActions } from './quick-actions-context';

interface VoiceIntent {
  id: symbol;
  key: string;
  scope: string;
  context: string;
}

export function QuickActionsProvider({ children }: { children: React.ReactNode }) {
  const [currentRoute, setCurrentRoute] = useState<CompanionViewLocation>({
    pathname: '',
    params: {},
  });
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const { pathname, params } = currentRoute;
  const routeKey = JSON.stringify([
    pathname,
    Object.entries(params).sort(([a], [b]) => a.localeCompare(b)),
  ]);
  const routeWorker = pathname === '/terminal/worker' ? tmuxWorkerRefFromRouteParams(params) : null;
  const currentWorkerKey = routeWorker ? quickVoiceWorkerKey(routeWorker) : '';
  const profile = useConnectionStore((state) => state.activeProfileId);
  const gateway = useConnectionStore((state) => state.gatewayUrl);
  const principal = useConnectionStore((state) => state.principalId);
  const authority = useConnectionStore((state) => state.authorityEpoch);
  const scope = JSON.stringify([profile, gateway, principal, authority]);
  const [composerInset, setComposerInset] = useState<ComposerInset | null>(null);
  const registerComposerInset = useCallback((inset: Omit<ComposerInset, 'owner'>) => {
    const owner = Symbol('visible voice composer');
    setComposerInset({ ...inset, owner });
    return () => setComposerInset((current) => (current?.owner === owner ? null : current));
  }, []);
  const [voiceTarget, setVoiceTarget] = useState<VoiceTarget | null>(null);
  const [viewSelection, setViewSelection] = useState<ViewSelection | null>(null);
  const [intent, setIntent] = useState<VoiceIntent | null>(null);
  const consumed = useRef<symbol | null>(null);
  const outlets = useRef(new Set<symbol>());
  const [activeOutlet, setActiveOutlet] = useState<symbol | null>(null);
  const [handoff, setHandoff] = useState<{ context: string; scope: string; path: string } | null>(
    null,
  );
  const registerOutlet = useCallback((owner: symbol) => {
    outlets.current.add(owner);
    setActiveOutlet(owner);
    return () => {
      outlets.current.delete(owner);
      setActiveOutlet([...outlets.current].at(-1) ?? null);
    };
  }, []);
  const beginCopilotVoice = useCallback(
    (context: string) => setHandoff({ context, scope, path: pathname }),
    [pathname, scope],
  );
  const finishHandoff = useCallback(() => setHandoff(null), []);
  useEffect(() => {
    if (handoff && (handoff.scope !== scope || handoff.path !== pathname)) setHandoff(null);
  }, [handoff, pathname, scope]);
  const previousPath = useRef(pathname);

  const registerVoice = useCallback((target: Omit<VoiceTarget, 'owner'>) => {
    const owner = Symbol('focused voice target');
    setVoiceTarget({ ...target, owner });
    return () => setVoiceTarget((current) => (current?.owner === owner ? null : current));
  }, []);
  const registerView = useCallback(
    (location: CompanionViewLocation, activeScope: string, ownerPath: string) => {
      const owner = Symbol('displayed view');
      setViewSelection({ owner, scope: activeScope, location, ownerPath });
      return () => setViewSelection((current) => (current?.owner === owner ? null : current));
    },
    [],
  );
  const requestVoice = useCallback(
    (key: string, context: string) => {
      setIntent({ id: Symbol('foreground voice gesture'), key, context, scope });
    },
    [scope],
  );

  useEffect(() => {
    const changedRoute = previousPath.current !== pathname;
    previousPath.current = pathname;
    if (
      intent &&
      (intent.scope !== scope ||
        (changedRoute && pathname !== '/terminal/worker') ||
        (pathname === '/terminal/worker' && currentWorkerKey !== intent.key))
    )
      setIntent(null);
  }, [currentWorkerKey, intent, pathname, scope]);

  useEffect(() => {
    if (
      !intent ||
      !voiceTarget ||
      !quickVoiceMayStart({ intent, target: voiceTarget, currentScope: scope, currentWorkerKey }) ||
      consumed.current === intent.id
    )
      return;
    consumed.current = intent.id;
    setIntent(null);
    voiceTarget.invoke(intent.context);
  }, [currentWorkerKey, intent, scope, voiceTarget]);

  const value = useMemo(
    () => ({
      scope,
      routeKey,
      currentRoute,
      voiceTarget,
      composerInset,
      registerComposerInset,
      viewSelection,
      registerVoice,
      registerView,
      requestVoice,
      beginCopilotVoice,
      handoffPending: Boolean(handoff),
      activeOutlet,
      registerOutlet,
    }),
    [
      scope,
      routeKey,
      currentRoute,
      voiceTarget,
      composerInset,
      registerComposerInset,
      viewSelection,
      registerVoice,
      registerView,
      requestVoice,
      beginCopilotVoice,
      handoff,
      activeOutlet,
      registerOutlet,
    ],
  );
  const [store] = useState(() => createQuickActionsStore(value));
  useLayoutEffect(() => store.set(value), [store, value]);
  return (
    <QuickActionsContext.Provider value={store}>
      {children}
      {mounted ? <CurrentRouteObserver onChange={setCurrentRoute} /> : null}
      {handoff ? (
        <CopilotVoiceHandoff context={handoff.context} scope={handoff.scope} done={finishHandoff} />
      ) : null}
    </QuickActionsContext.Provider>
  );
}

/** Read navigation only after the provider and its navigator have committed. */
function CurrentRouteObserver({
  onChange,
}: {
  onChange: React.Dispatch<React.SetStateAction<CompanionViewLocation>>;
}) {
  const pathname = usePathname();
  const params = useGlobalSearchParams();
  useEffect(() => {
    onChange((current) =>
      current.pathname === pathname && JSON.stringify(current.params) === JSON.stringify(params)
        ? current
        : { pathname, params },
    );
  }, [onChange, params, pathname]);
  return null;
}

export function useQuickActionVoiceTarget(
  key: string,
  invoke: (context?: string) => void,
  ready: boolean,
  enabled = true,
) {
  const latestInvoke = useRef(invoke);
  useLayoutEffect(() => {
    latestInvoke.current = invoke;
  }, [invoke]);
  const invokeCurrent = useCallback((context?: string) => latestInvoke.current(context), []);
  const register = useQuickActionsField('registerVoice');
  const scope = useQuickActionsField('scope');
  const routeKey = useQuickActionsField('routeKey');
  useFocusEffect(
    useCallback(() => {
      if (!register || !scope || !routeKey || !enabled) return;
      return register({ key, invoke: invokeCurrent, ready, scope, routeKey });
    }, [enabled, invokeCurrent, key, ready, register, routeKey, scope]),
  );
}

export function useSharedViewSelection(location: CompanionViewLocation) {
  const latestLocation = useRef(location);
  useLayoutEffect(() => {
    latestLocation.current = location;
  }, [location]);
  const selectionKey = JSON.stringify(location);
  const ownerPath = usePathname();
  const register = useQuickActionsField('registerView');
  const scope = useQuickActionsField('scope');
  useFocusEffect(
    useCallback(() => {
      if (!register || !scope) return;
      return register(latestLocation.current, scope, ownerPath);
    }, [selectionKey, ownerPath, register, scope]),
  );
}
