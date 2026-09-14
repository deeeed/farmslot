import { useEffect, useRef, useState } from 'react';

import {
  Methods,
  nativeProfileSessionParams,
  type NativeSessionCatalogResult,
  type NativeSessionInfo,
} from '@farmslot/protocol';

import { useConnectionStore } from '../../store/connection';

import { useNativeProfileSelection } from './use-native-profile-selection';

export function useNativeSessionSetup(enabled: boolean) {
  const client = useConnectionStore((state) => state.client);
  const status = useConnectionStore((state) => state.status);
  const principalId = useConnectionStore((state) => state.principalId);
  const access = useConnectionStore((state) => state.workspaceAccess);
  const [catalog, setCatalog] = useState<NativeSessionCatalogResult>();
  const [contextKey, setContextKey] = useState('');
  const [catalogReadyFor, setCatalogReadyFor] = useState('');
  const [runnerId, setRunnerId] = useState('');
  const [modelId, setModelId] = useState('');
  const [mode, setMode] = useState<'default' | 'plan'>('default');
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const catalogKey = JSON.stringify([principalId, client?.connectionGeneration, status, refresh]);
  const currentCatalogKey = useRef(catalogKey);
  currentCatalogKey.current = catalogKey;
  const alive = useRef(true);
  const mutation = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!enabled || !client || status !== 'connected' || access === 'none') return;
    let current = true;
    const generation = client.connectionGeneration;
    const isCurrent = () =>
      current &&
      currentCatalogKey.current === catalogKey &&
      client.connectionGeneration === generation &&
      (client.authenticatedPrincipal?.id ?? null) === principalId;
    setLoading(true);
    setError('');
    void client.request<NativeSessionCatalogResult>(Methods.NATIVE_SESSION_CATALOG, {}).then(
      (result) => {
        if (isCurrent()) {
          setCatalog(result);
          setRunnerId((current) => current || result.runners[0]?.runner || '');
          setContextKey(
            (current) => current || (result.contexts[0] ? workspaceKey(result.contexts[0]) : ''),
          );
          setCatalogReadyFor(catalogKey);
          setLoading(false);
        }
      },
      (cause) => {
        if (isCurrent()) {
          setError(String(cause));
          setLoading(false);
        }
      },
    );
    return () => {
      current = false;
    };
  }, [enabled, client, status, principalId, access, refresh, catalogKey]);
  const runner = runnerId
    ? catalog?.runners.find((item) => item.runner === runnerId)
    : catalog?.runners[0];
  const model = runner?.models.includes(modelId) ? modelId : (runner?.defaultModel ?? '');
  const contextIndex =
    catalog?.contexts.findIndex((item) => workspaceKey(item) === contextKey) ?? -1;
  const context = catalog?.contexts[contextIndex];
  const selectedNode = useRef('local');
  if (context) selectedNode.current = context.executionNodeId ?? 'local';
  const selectedMode = runner?.modes.includes(mode) ? mode : (runner?.modes[0] ?? 'default');
  const catalogReady = catalogReadyFor === catalogKey && status === 'connected';
  const profiles = useNativeProfileSelection({
    enabled: enabled && catalogReady && !!context && !!runner,
    node: selectedNode.current,
    runner: runnerId || runner?.runner || '',
    supported: context?.supportsProfiles === true,
    refreshKey: catalogKey,
  });
  const launchKey = JSON.stringify([
    catalogKey,
    contextKey,
    runner?.runner,
    model,
    selectedMode,
    profiles.viewModel.selected,
  ]);
  const launchKeyRef = useRef(launchKey);
  launchKeyRef.current = launchKey;
  return {
    viewModel: {
      catalog,
      contextIndex,
      contextUnavailable: !!contextKey && !context,
      runner: runner?.runner,
      model,
      mode: selectedMode,
      loading,
      profiles: profiles.viewModel,
      creating,
      controlsDisabled: creating || !catalogReady,
      error,
      canCreate:
        enabled &&
        status === 'connected' &&
        access !== 'none' &&
        !!context &&
        !!runner &&
        !loading &&
        catalogReady &&
        profiles.viewModel.ready &&
        !creating,
    },
    actions: {
      profiles: {
        ...profiles.actions,
        choose: (id: string) => {
          setError('');
          profiles.actions.choose(id);
        },
        refresh: () => {
          setError('');
          profiles.actions.refresh();
        },
      },
      selectContext: (index: number) => {
        const next = catalog?.contexts[index];
        if (next && workspaceKey(next) !== contextKey) {
          launchKeyRef.current = '';
          setContextKey(workspaceKey(next));
        }
      },
      selectRunner: (value: string) => {
        if (value === runnerId) return;
        launchKeyRef.current = '';
        setRunnerId(value);
        setModelId('');
        setMode('default');
      },
      selectModel: (value: string) => {
        if (value === modelId) return;
        launchKeyRef.current = '';
        setModelId(value);
      },
      selectMode: (value: 'default' | 'plan') => {
        if (value === mode) return;
        launchKeyRef.current = '';
        setMode(value);
      },
      refresh: () => {
        currentCatalogKey.current = '';
        launchKeyRef.current = '';
        setRefresh((value) => value + 1);
      },
      create: async (): Promise<NativeSessionInfo | undefined> => {
        if (
          !enabled ||
          !client ||
          status !== 'connected' ||
          access === 'none' ||
          !context ||
          !runner ||
          loading ||
          !catalogReady ||
          !profiles.viewModel.ready ||
          mutation.current
        )
          return;
        mutation.current = true;
        setCreating(true);
        setError('');
        const generation = client.connectionGeneration;
        try {
          const profile = await profiles.actions.validate();
          if (
            !alive.current ||
            client.connectionGeneration !== generation ||
            currentCatalogKey.current !== catalogKey ||
            launchKeyRef.current !== launchKey
          )
            throw new Error('Conversation settings changed before launch.');
          const result = await client.request<{ session: NativeSessionInfo }>(
            Methods.NATIVE_SESSION_CREATE,
            {
              executionNodeId: context.executionNodeId ?? 'local',
              cwd: context.cwd,
              runner: runner.runner,
              ...(model ? { model } : {}),
              mode: selectedMode,
              ...nativeProfileSessionParams(profile),
            },
            30_000,
          );
          if (
            alive.current &&
            client.connectionGeneration === generation &&
            (client.authenticatedPrincipal?.id ?? null) === principalId
          )
            return result.session;
        } catch (cause) {
          if (alive.current && client.connectionGeneration === generation) setError(String(cause));
        } finally {
          mutation.current = false;
          if (alive.current) setCreating(false);
        }
      },
    },
  };
}

function workspaceKey(context: NativeSessionCatalogResult['contexts'][number]) {
  return JSON.stringify([context.executionNodeId ?? 'local', context.cwd]);
}
