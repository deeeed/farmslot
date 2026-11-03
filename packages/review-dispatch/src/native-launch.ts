import type { NativeSessionCatalogResult, SlotStatus } from '@farmslot/protocol';

export interface NativeLaunchChoice {
  key: string;
  label: string;
  cwd: string;
  executionNodeId: string;
  project: string | null;
  slotId: string | null;
  kind: 'workspace' | 'custom';
  supportsProfiles: boolean;
  unavailableReason: string | null;
}

export function nativeLaunchContextKey(context: { cwd: string; executionNodeId?: string }): string {
  return JSON.stringify([context.executionNodeId ?? 'local', context.cwd]);
}

/** Targets, homes and launch authority come from the catalog, never an inferred owner. */
export function nativeLaunchChoices(
  catalog: NativeSessionCatalogResult,
  filters: { projects: readonly string[]; machines: readonly string[] },
  slots: readonly Pick<SlotStatus, 'slot' | 'project' | 'machine'>[] = [],
): NativeLaunchChoice[] {
  const nodes = catalog.executionNodes ?? [];
  const reason = (id: string) => {
    const node = nodes.find((node) => node.executionNodeId === id);
    return (
      node?.unavailableReason ??
      (!node?.homeDirectory
        ? 'Execution metadata unavailable. Refresh after the node update.'
        : null)
    );
  };
  const choices: NativeLaunchChoice[] = catalog.contexts.flatMap((context) => {
    const slot = slots.find((slot) => slot.slot === context.slotId);
    const node = context.executionNodeId ?? 'local';
    const project = context.project ?? slot?.project ?? null;
    if (filters.projects.length && (!project || !filters.projects.includes(project))) return [];
    if (filters.machines.length && !filters.machines.includes(slot?.machine ?? node)) return [];
    return [
      {
        key: nativeLaunchContextKey(context),
        label: context.slotId ?? context.label,
        cwd: context.cwd,
        executionNodeId: node,
        project,
        slotId: context.slotId ?? null,
        kind: 'workspace',
        supportsProfiles: context.supportsProfiles === true,
        unavailableReason: reason(node),
      },
    ];
  });
  choices.sort((a, b) =>
    `${a.project ?? ''}:${a.executionNodeId}:${a.label}`.localeCompare(
      `${b.project ?? ''}:${b.executionNodeId}:${b.label}`,
    ),
  );
  const ids = new Set([
    ...nodes.map((node) => node.executionNodeId),
    ...catalog.contexts.map((context) => context.executionNodeId ?? 'local'),
    ...slots.map((slot) => slot.machine),
  ]);
  for (const id of [...ids].sort()) {
    if (filters.machines.length && !filters.machines.includes(id)) continue;
    const node = nodes.find((node) => node.executionNodeId === id);
    choices.push({
      key: `custom:${id}`,
      label: `Custom directory · ${node?.label ?? id}`,
      cwd: node?.homeDirectory ?? '',
      executionNodeId: id,
      project: null,
      slotId: null,
      kind: 'custom',
      supportsProfiles: catalog.contexts.some(
        (context) =>
          (context.executionNodeId ?? 'local') === id && context.supportsProfiles === true,
      ),
      unavailableReason: reason(id),
    });
  }
  return choices;
}
