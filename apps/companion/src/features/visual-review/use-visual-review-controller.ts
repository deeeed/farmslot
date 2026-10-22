import * as FileSystem from 'expo-file-system/legacy';
import { useIsFocused } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Platform, Share } from 'react-native';

import { Methods, type RunGetResult, type RunRecipeRunsForRunResult } from '@farmslot/protocol';
import { type ResourceQuery, resourceQuery } from '@farmslot/protocol/client-cache';

import { observeNativeVisualReview } from '../../farmslot/run-collections-proof';
import { useResourceQuery } from '../../hooks/useResourceQuery';
import { currentFarmConnection } from '../../lib/connection-authority';
import {
  getResourceCache,
  getResourceWorkspaceKey,
  subscribeResourceCache,
} from '../../lib/resource-cache';
import {
  createVisualReviewGateway,
  visualReviewConnectionId,
} from '../../lib/visual-review-gateway';
import { useConnectionStore } from '../../store/connection';

import { VisualReviewController, type VisualReviewRouteParams } from './visual-review-controller';

/** Same file name as the HTML board download, so either renderer reopens it. */
const EXPORT_FILE_NAME = 'visual-feedback.json';

export function useVisualReviewController(route: VisualReviewRouteParams) {
  const focused = useIsFocused();
  const client = useConnectionStore((s) => s.client);
  const gatewayUrl = useConnectionStore((s) => s.gatewayUrl);
  const authHeaders = useConnectionStore((s) => s.activeProfileHttpAuthHeaders);
  const profileId = useConnectionStore((s) => s.activeProfileId);
  const connection = useConnectionStore((s) => s.status);
  const epoch = useConnectionStore((s) => s.authorityEpoch);
  const cache = useSyncExternalStore(subscribeResourceCache, getResourceCache, getResourceCache);
  const workspaceKey = useSyncExternalStore(
    subscribeResourceCache,
    getResourceWorkspaceKey,
    getResourceWorkspaceKey,
  );
  const { runId, sourcePath, recipeRunId } = route;
  const identity = visualReviewConnectionId({ gatewayUrl, authHeaders, profileId });
  const controller = useMemo(
    () => new VisualReviewController({ runId, sourcePath, recipeRunId }),
    [recipeRunId, runId, sourcePath, workspaceKey, identity, epoch],
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const currentController = useRef(controller);
  currentController.current = controller;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.setGateway(null);
    };
  }, [controller]);
  const runQuery = useMemo(() => resourceQuery<RunGetResult>(Methods.RUN_GET, { runId }), [runId]);
  const recipeQuery = useMemo(
    () => resourceQuery<RunRecipeRunsForRunResult>(Methods.RUN_RECIPE_RUNS_FOR_RUN, { runId }),
    [runId],
  );
  const runObservation = useResourceQuery(runQuery);
  const recipeObservation = useResourceQuery(recipeQuery);
  const targetRunId = state.status === 'ready' ? state.targetRunId : runId;
  const targetQuery = useMemo(
    () => resourceQuery<RunGetResult>(Methods.RUN_GET, { runId: targetRunId }),
    [targetRunId],
  );
  const targetObservation = useResourceQuery(targetQuery);
  const sourceReady = runObservation.status === 'ready' && recipeObservation.status === 'ready';
  const commandsReady =
    connection === 'connected' && sourceReady && targetObservation.status === 'ready';
  const frame = useRef({
    focused,
    run: runObservation.data?.run ?? null,
    recipes: recipeObservation,
    state,
    target: targetObservation,
    commandsReady,
  });
  frame.current = {
    focused,
    run: runObservation.data?.run ?? null,
    recipes: recipeObservation,
    state,
    target: targetObservation,
    commandsReady,
  };
  useEffect(() => {
    if (__DEV__) return observeNativeVisualReview(runId, () => frame.current);
  }, [runId]);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const generation = client?.connectionGeneration;
  const gateway = useMemo(() => {
    if (!focused || !client || !cache || connection !== 'connected') return null;
    const connected = currentFarmConnection(client, useConnectionStore.getState);
    return createVisualReviewGateway(
      client,
      { gatewayUrl, authHeaders, profileId },
      {
        cache,
        sourceRunId: runId,
        current: () =>
          mounted.current &&
          currentController.current === controller &&
          cache === getResourceCache() &&
          workspaceKey === getResourceWorkspaceKey() &&
          connected(),
      },
      () => {
        const live = useConnectionStore.getState();
        return {
          gatewayUrl: live.gatewayUrl,
          authHeaders: live.activeProfileHttpAuthHeaders,
          profileId: live.activeProfileId,
        };
      },
    );
  }, [
    focused,
    client,
    cache,
    connection,
    generation,
    workspaceKey,
    identity,
    epoch,
    controller,
    runId,
  ]);

  useEffect(() => {
    // Observation invalidation pauses new commands; an on-wire delivery still
    // belongs to this connection and must retain its eventual acknowledgement.
    controller.setGateway(gateway, sourceReady);
  }, [controller, gateway, sourceReady]);
  useEffect(() => () => controller.setGateway(null), [controller, gateway]);
  useEffect(() => setExportMessage(null), [controller]);
  const retry = useCallback(async () => {
    const current = getResourceCache();
    const queries: ResourceQuery<unknown>[] = [runQuery, recipeQuery, targetQuery];
    await Promise.all(
      queries.filter((query) => current?.read(query).error).map((query) => current?.retry(query)),
    );
    if (mounted.current && currentController.current === controller) await controller.load();
  }, [controller, runQuery, recipeQuery, targetQuery]);

  const exportFeedback = useCallback(async () => {
    try {
      const json = `${JSON.stringify(controller.exportDocument(), null, 2)}\n`;
      let result: Awaited<ReturnType<typeof Share.share>>;
      // React Native's Share only attaches files on iOS; elsewhere the JSON is shared as text.
      const sharedFile = Platform.OS === 'ios' && !!FileSystem.cacheDirectory;
      if (sharedFile) {
        const uri = `${FileSystem.cacheDirectory}${EXPORT_FILE_NAME}`;
        await FileSystem.writeAsStringAsync(uri, json);
        if (!mounted.current || currentController.current !== controller) return;
        result = await Share.share({ url: uri, title: EXPORT_FILE_NAME });
      } else {
        result = await Share.share({ message: json, title: EXPORT_FILE_NAME });
      }
      if (!mounted.current || currentController.current !== controller) return;
      if (result.action === Share.dismissedAction) {
        setExportMessage('Export cancelled.');
        return;
      }
      setExportMessage(
        sharedFile
          ? `Exported ${EXPORT_FILE_NAME}. Open it in the HTML board to continue.`
          : `Shared the feedback JSON as text. Save it as ${EXPORT_FILE_NAME} to open it in the HTML board.`,
      );
    } catch (error) {
      if (!mounted.current || currentController.current !== controller) return;
      // Export problems are shown next to the button; the draft is unaffected.
      setExportMessage(`Export failed: ${(error as Error).message}`);
    }
  }, [controller]);

  const actions = useMemo(
    () => ({
      retry: () => void retry(),
      selectSurface: controller.selectSurface.bind(controller),
      selectCapture: controller.selectCapture.bind(controller),
      setMode: controller.setMode.bind(controller),
      setSurfaceNote: controller.setSurfaceNote.bind(controller),
      addAnnotation: controller.addAnnotation.bind(controller),
      selectAnnotation: controller.selectAnnotation.bind(controller),
      moveAnnotation: controller.moveAnnotation.bind(controller),
      updateAnnotation: controller.updateAnnotation.bind(controller),
      removeAnnotation: controller.removeAnnotation.bind(controller),
      exportFeedback: () => void exportFeedback(),
      submit: () => void controller.submit(),
    }),
    [controller, exportFeedback, retry],
  );

  return {
    state,
    runObservation,
    recipeObservation,
    targetObservation,
    commandsReady,
    exportMessage,
    actions,
  };
}

export type VisualReviewActions = ReturnType<typeof useVisualReviewController>['actions'];
