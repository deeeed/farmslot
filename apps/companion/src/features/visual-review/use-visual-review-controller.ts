import * as FileSystem from 'expo-file-system/legacy';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Platform, Share } from 'react-native';

import { createVisualReviewGateway } from '../../lib/visual-review-gateway';
import { useConnectionStore } from '../../store/connection';

import { VisualReviewController, type VisualReviewRouteParams } from './visual-review-controller';

/** Same file name as the HTML board download, so either renderer reopens it. */
const EXPORT_FILE_NAME = 'visual-feedback.json';

export function useVisualReviewController(route: VisualReviewRouteParams) {
  const client = useConnectionStore((s) => s.client);
  const gatewayUrl = useConnectionStore((s) => s.gatewayUrl);
  const authHeaders = useConnectionStore((s) => s.activeProfileHttpAuthHeaders);
  const { runId, sourcePath, recipeRunId } = route;
  const controller = useMemo(
    () => new VisualReviewController({ runId, sourcePath, recipeRunId }),
    [recipeRunId, runId, sourcePath],
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const [exportMessage, setExportMessage] = useState<string | null>(null);

  useEffect(() => {
    controller.setGateway(
      client ? createVisualReviewGateway(client, gatewayUrl, authHeaders) : null,
    );
  }, [authHeaders, client, controller, gatewayUrl]);

  const exportFeedback = useCallback(async () => {
    try {
      const json = `${JSON.stringify(controller.exportDocument(), null, 2)}\n`;
      let result: Awaited<ReturnType<typeof Share.share>>;
      if (Platform.OS === 'ios' && FileSystem.cacheDirectory) {
        const uri = `${FileSystem.cacheDirectory}${EXPORT_FILE_NAME}`;
        await FileSystem.writeAsStringAsync(uri, json);
        result = await Share.share({ url: uri, title: EXPORT_FILE_NAME });
      } else {
        result = await Share.share({ message: json, title: EXPORT_FILE_NAME });
      }
      if (result.action === Share.dismissedAction) {
        setExportMessage('Export cancelled.');
        return;
      }
      setExportMessage(`Exported ${EXPORT_FILE_NAME}. Open it in the HTML board to continue.`);
    } catch (error) {
      // Export problems are shown next to the button; the draft is unaffected.
      setExportMessage(`Export failed: ${(error as Error).message}`);
    }
  }, [controller]);

  const actions = useMemo(
    () => ({
      retry: () => void controller.load(),
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
    [controller, exportFeedback],
  );

  return { state, exportMessage, actions };
}

export type VisualReviewActions = ReturnType<typeof useVisualReviewController>['actions'];
