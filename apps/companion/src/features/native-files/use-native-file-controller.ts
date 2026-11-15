import { useCallback, useEffect, useMemo } from 'react';

import {
  Methods,
  type NativeWorkspaceReadResult,
  viewChoiceField,
  viewToggleField,
} from '@farmslot/protocol';
import { nativeObservationQuery } from '@farmslot/protocol/client-cache';

import { useViewChoice } from '../../components/view-state';
import { recordNativeFile } from '../../farmslot/native-render-proof';
import { useResourceQuery } from '../../hooks/useResourceQuery';
import {
  type NativeFileRouteParams,
  nativeFileRouteTarget,
} from '../../lib/native-workspace-target';
import { getResourceNativeOwnerId } from '../../lib/resource-cache';
import type { NativeReviewDiffDebugEvent } from '../../t3/features/diffs/nativeReviewDiffSurface';
import { isMarkdownPreviewFile } from '../../t3/features/files/filePath';
import type { SourceFileRendered } from '../../t3/features/files/SourceFileSurface';

export type NativeFileMode = 'source' | 'rendered' | 'raw';

export function useNativeFileController(
  params: Partial<Record<keyof NativeFileRouteParams, string>>,
) {
  const {
    sessionId: id,
    executionNodeId,
    path: file,
    line: at,
    cwd,
    runId,
    contextId,
    generation,
    leaseId,
  } = params;
  const route = useMemo(
    () =>
      nativeFileRouteTarget({
        sessionId: id,
        executionNodeId,
        path: file,
        line: at,
        cwd,
        runId,
        contextId,
        generation,
        leaseId,
      }),
    [id, executionNodeId, file, at, cwd, runId, contextId, generation, leaseId],
  );
  const owner = getResourceNativeOwnerId();
  const query = useMemo(
    () =>
      route && owner
        ? nativeObservationQuery<NativeWorkspaceReadResult>(
            Methods.NATIVE_SESSION_WORKSPACE_READ,
            { ...route.target, path: route.location.path },
            owner,
          )
        : undefined,
    [route, owner],
  );
  const observation = useResourceQuery(query);
  const markdown = route ? isMarkdownPreviewFile(route.location.path) : false;
  const [view, setView] = useViewChoice(
    viewChoiceField<'rendered' | 'raw'>('nativeFileMarkdown', 'rendered', ['rendered', 'raw']),
  );
  const [selectable, setSelectable] = useViewChoice(
    viewToggleField('panels', 'native-file-select', false),
  );
  const mode: NativeFileMode = markdown ? view : 'source';
  const sessionId = route?.target.sessionId;
  const path = route?.location.path;
  const line = route?.location.line;
  useEffect(() => {
    if (sessionId && path) recordNativeFile(sessionId, { path, line, mode, markdown: undefined });
  }, [sessionId, path, line, mode]);
  const onSourceRendered = useCallback(
    (rendered: SourceFileRendered) => {
      if (sessionId && path) recordNativeFile(sessionId, { path, ...rendered });
    },
    [sessionId, path],
  );
  const onMarkdownRendered = useCallback(
    (rendered: Parameters<typeof recordNativeFile>[1]['markdown']) => {
      if (sessionId && path) recordNativeFile(sessionId, { path, markdown: rendered });
    },
    [sessionId, path],
  );
  const onSourceDebug = useCallback(
    ({ nativeEvent }: NativeReviewDiffDebugEvent) => {
      if (!sessionId || !path || nativeEvent.message !== 'visible-range') return;
      const { firstRowIndex: first, lastRowIndex: last } = nativeEvent;
      if (typeof first === 'number' && typeof last === 'number')
        recordNativeFile(sessionId, { path, visibleRange: { first, last } });
    },
    [sessionId, path],
  );
  return {
    viewModel: {
      route,
      path,
      line,
      markdown,
      mode,
      selectable,
      content: observation.data?.content,
      status: route ? observation.status : ('error' as const),
      error: route ? observation.error?.message : 'This file link is missing its session or path.',
    },
    actions: {
      setMode: (next: 'rendered' | 'raw') => setView(next),
      setSelectable,
      onSourceRendered,
      onMarkdownRendered,
      onSourceDebug,
    },
  };
}
