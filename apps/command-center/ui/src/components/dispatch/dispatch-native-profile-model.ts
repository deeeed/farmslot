import type { NativeProfileReference, NativeSessionCatalogResult } from '@farmslot/protocol';

export interface DispatchNativeProfileSelection {
  key: string;
  executionNodeId?: string;
  profile?: NativeProfileReference;
  ready: boolean;
}

export interface DispatchNativeProfileContext {
  runner: string;
  slotId: string;
  project: string;
  refreshVersion: number;
}

export function dispatchNativeProfileKey(context: DispatchNativeProfileContext): string {
  return JSON.stringify([context.runner, context.slotId, context.project, context.refreshVersion]);
}

export function nativeContextNode(context: NativeSessionCatalogResult['contexts'][number]): string {
  return context.executionNodeId ?? 'local';
}

export function nativeDispatchNodeSlots(
  catalog: NativeSessionCatalogResult | undefined,
  executionNodeId: string,
  project: string,
): string[] {
  return [
    ...new Set(
      (catalog?.contexts ?? []).flatMap((context) =>
        context.slotId &&
        context.project === project &&
        nativeContextNode(context) === executionNodeId
          ? [context.slotId]
          : [],
      ),
    ),
  ];
}

export function nativeDispatchProfileReason(
  input: DispatchNativeProfileContext & {
    selection: DispatchNativeProfileSelection | null;
    catalog: NativeSessionCatalogResult | undefined;
    catalogReady: boolean;
  },
): string | null {
  const selection = input.selection;
  if (!input.catalogReady || !selection || selection.key !== dispatchNativeProfileKey(input))
    return 'Checking native worker profile choices.';
  if (!selection.ready) return 'Choose an available profile and refresh its native login status.';
  if (
    selection.profile &&
    (selection.profile.runner !== input.runner ||
      selection.profile.executionNodeId !== selection.executionNodeId)
  )
    return 'Choose a profile for the selected runner and node.';
  if (selection.executionNodeId) {
    const slots = nativeDispatchNodeSlots(input.catalog, selection.executionNodeId, input.project);
    if (!slots.length || (input.slotId && !slots.includes(input.slotId)))
      return 'The selected node has no matching slot for this dispatch.';
    if (
      selection.profile &&
      !input.catalog?.contexts.some(
        (context) =>
          nativeContextNode(context) === selection.executionNodeId &&
          context.supportsProfiles &&
          (!input.slotId || context.slotId === input.slotId),
      )
    )
      return 'Profiles are unavailable on the selected node.';
  }
  return null;
}
