import { useEffect, useMemo, useRef, useState } from 'react';

import {
  Methods,
  nativeProfileSessionParams,
  type NativeSessionCatalogResult,
  type NativeSessionInfo,
} from '@farmslot/protocol';
import { nativeObservationQuery } from '@farmslot/protocol/client-cache';
import {
  catalogForNativeRunners,
  nativeLaunchChoices,
  nativeLaunchContextKey,
  nativeLaunchModel,
  ReviewDispatchViewModel,
} from '@farmslot/review-dispatch';

import { useResourceQuery } from '../../hooks/useResourceQuery';
import { getResourceCache, getResourceNativeOwnerId } from '../../lib/resource-cache';
import { readErrorMessage } from '../../lib/resource-read-status';
import { useConnectionStore } from '../../store/connection';
import { useFilterStore } from '../../store/filters';
import { useFleetStore } from '../../store/fleet';
import { heldConnectionCurrent } from '../../store/held-connection';

import { useNativeProfileSelection } from './use-native-profile-selection';

export function useNativeSessionSetup(enabled: boolean) {
  const client = useConnectionStore((state) => state.client);
  const status = useConnectionStore((state) => state.status);
  const principalId = useConnectionStore((state) => state.principalId);
  const access = useConnectionStore((state) => state.workspaceAccess);
  const [contextKey, setContextKey] = useState('');
  const [customCwd, setCustomCwd] = useState<string>();
  const [effort, setEffort] = useState<string | null>(null);
  const filters = useFilterStore((state) => state.filters);
  const fleet = useFleetStore((state) => state.fleet);
  const [runnerId, setRunnerId] = useState('');
  const [modelId, setModelId] = useState('');
  const [mode, setMode] = useState<'default' | 'plan'>('default');
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
  const nativeOwner = getResourceNativeOwnerId();
  const catalogQuery = useMemo(
    () =>
      enabled && nativeOwner
        ? nativeObservationQuery<NativeSessionCatalogResult>(
            Methods.NATIVE_SESSION_CATALOG,
            {},
            nativeOwner,
          )
        : undefined,
    [enabled, nativeOwner],
  );
  const catalogObservation = useResourceQuery(catalogQuery);
  const savedCatalog = catalogObservation.data;
  const choices = useMemo(
    () => (savedCatalog ? nativeLaunchChoices(savedCatalog, filters, fleet?.slots ?? []) : []),
    [savedCatalog, filters, fleet],
  );
  const catalog = savedCatalog;
  const loading = catalogObservation.status === 'loading';
  useEffect(() => {
    if (catalogObservation.status !== 'ready' || !catalog) return;
    setRunnerId((current) => current || catalog.runners[0]?.runner || '');
    setContextKey(
      (current) => current || choices.find((choice) => !choice.unavailableReason)?.key || '',
    );
  }, [catalogObservation.status, catalog, choices]);
  const runner = runnerId
    ? catalog?.runners.find((item) => item.runner === runnerId)
    : catalog?.runners[0];
  const choice = choices.find((item) => item.key === contextKey);
  const context =
    choice && !choice.unavailableReason
      ? { ...choice, cwd: choice.kind === 'custom' ? (customCwd ?? choice.cwd) : choice.cwd }
      : undefined;
  const contextIndex =
    catalog?.contexts.findIndex((item) => nativeLaunchContextKey(item) === contextKey) ?? -1;
  // Pi and OpenCode list the models of the node the session will run on.
  const executionNode = context?.executionNodeId ?? 'local';
  const runnerCatalog = useMemo(
    () =>
      catalog ? catalogForNativeRunners(catalog.runners, undefined, executionNode) : undefined,
    [catalog, executionNode],
  );
  const model = nativeLaunchModel(
    runnerCatalog?.runners.find((entry) => entry.id === runner?.runner),
    modelId,
  );
  const executionPicker = useMemo(
    () =>
      catalog?.runners.length && runnerCatalog
        ? new ReviewDispatchViewModel({
            context: { allowedActions: ['chat'] },
            catalog: runnerCatalog,
            sequence: [
              {
                runner: runner?.runner ?? catalog.runners[0].runner,
                model: model || null,
                effort,
                mode: 'cold',
              },
            ],
          })
        : undefined,
    [catalog, runnerCatalog, runner, model, effort],
  );
  const selectedNode = useRef('local');
  if (context) selectedNode.current = context.executionNodeId ?? 'local';
  const selectedMode = runner?.modes.includes(mode) ? mode : (runner?.modes[0] ?? 'default');
  const catalogReady = catalogObservation.status === 'ready' && status === 'connected';
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
    context?.cwd,
    effort,
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
      choices,
      contextKey,
      customCwd: context?.cwd ?? '',
      custom: choice?.kind === 'custom',
      executionPicker,
      contextIndex,
      contextUnavailable: !!contextKey && !context,
      runner: runner?.runner,
      model,
      mode: selectedMode,
      loading,
      profiles: profiles.viewModel,
      creating,
      controlsDisabled: creating || !catalogReady,
      catalogError: readErrorMessage(catalogObservation, heldConnectionCurrent()),
      error: error || readErrorMessage(catalogObservation, heldConnectionCurrent()),
      canCreate:
        enabled &&
        status === 'connected' &&
        access !== 'none' &&
        !!context?.cwd.trim() &&
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
      selectChoice: (key: string) => {
        const next = choices.find((choice) => choice.key === key);
        if (!next || next.unavailableReason) return;
        launchKeyRef.current = '';
        setError('');
        setContextKey(key);
        setCustomCwd(next.cwd);
      },
      selectCustomCwd: (value: string) => {
        launchKeyRef.current = '';
        setError('');
        setCustomCwd(value);
      },
      selectEffort: (value: string | null) => {
        launchKeyRef.current = '';
        setError('');
        setEffort(value);
      },
      selectContext: (index: number) => {
        setError('');
        const next = catalog?.contexts[index];
        if (next && nativeLaunchContextKey(next) !== contextKey) {
          launchKeyRef.current = '';
          setContextKey(nativeLaunchContextKey(next));
        }
      },
      selectRunner: (value: string) => {
        setError('');
        if (value === runnerId) return;
        launchKeyRef.current = '';
        setRunnerId(value);
        setModelId('');
        setMode('default');
      },
      selectModel: (value: string) => {
        setError('');
        if (value === modelId) return;
        launchKeyRef.current = '';
        setModelId(value);
      },
      selectMode: (value: 'default' | 'plan') => {
        setError('');
        if (value === mode) return;
        launchKeyRef.current = '';
        setMode(value);
      },
      refresh: () => {
        currentCatalogKey.current = '';
        launchKeyRef.current = '';
        setRefresh((value) => value + 1);
        if (catalogQuery)
          void getResourceCache()
            ?.retry(catalogQuery)
            .catch((cause) => setError(String(cause)));
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
              ...(effort ? { effort } : {}),
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
