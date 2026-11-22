import type { RunEvidenceFlow, RunEvidenceFlowOccurrence } from '@farmslot/adapter-sdk/evidence';

import { buildHash, hashParams, parseHashRoute } from '../../utils/url-state.js';

export interface ComposedEvidencePosition {
  recipeRunId: string;
  invocationId: string;
}

// Use the existing shareable recipe-node field, qualified for Run Detail.
const CALL_PARAM = 'recipeNode';

export function composedEvidenceNode(
  flow: RunEvidenceFlow | null,
  position: ComposedEvidencePosition | null,
) {
  if (!flow) return undefined;
  const selected =
    position?.recipeRunId === flow.recipeRunId
      ? flow.nodes.find(({ id }) => id === position.invocationId)
      : undefined;
  return selected ?? flow.nodes.find(({ id }) => id === (flow.activeId ?? flow.rootId));
}

export function composedEvidenceOccurrenceKey(
  occurrence: Pick<RunEvidenceFlowOccurrence, 'recipeRunId' | 'traceIndex'>,
): string {
  return JSON.stringify([occurrence.recipeRunId, occurrence.traceIndex]);
}

export function composedEvidencePositionFromHash(
  runId: string,
  hash: string,
): ComposedEvidencePosition | null {
  const value = hashParams(hash).get(CALL_PARAM);
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [owner, recipeRunId, invocationId] = parsed;
    if (
      owner !== runId ||
      typeof recipeRunId !== 'string' ||
      !recipeRunId ||
      typeof invocationId !== 'string' ||
      !invocationId
    )
      return null;
    return { recipeRunId, invocationId };
  } catch {
    // A hand-edited or old link falls back to the SDK active call.
    return null;
  }
}

export function composedEvidenceSelectionHash(
  runId: string,
  position: ComposedEvidencePosition | null,
  hash: string,
): string {
  const { route, params } = parseHashRoute(hash);
  if (position)
    params.set(CALL_PARAM, JSON.stringify([runId, position.recipeRunId, position.invocationId]));
  else params.delete(CALL_PARAM);
  return buildHash(route, params);
}

export function composedEvidenceRecipeGroup(
  groups: readonly { id: string; recipeRunId: string | null }[],
  position: ComposedEvidencePosition | null,
  selectedGroup: string | null,
): string | undefined {
  if (!position) return undefined;
  const matching = groups.filter((group) => group.recipeRunId === position.recipeRunId);
  return matching.find((group) => group.id === selectedGroup)?.id ?? matching[0]?.id;
}
