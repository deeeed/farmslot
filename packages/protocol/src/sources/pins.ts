import type { SourceDeclaration, SourceLock, SourcePin } from './contracts.js';

export interface SourceSelection {
  sourceId: string;
  selection: 'branch' | 'main';
  ref?: string;
}

export interface SourcePinTarget {
  scope: SourcePin['scope'];
  targetId: string;
}

export interface SourceEffectiveSelection {
  sourceId: string;
  declaredRef: string;
  effectiveRef: string;
  scope: SourcePin['scope'];
  pin?: SourcePin;
  shadowedPins: SourcePin[];
}

/** Branch syntax is portable; the gateway must also verify it exists upstream. */
export function isSourceBranchRef(ref: string): boolean {
  const branch = ref.replace(/^refs\/heads\//, '');
  return (
    /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch) &&
    !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(branch) &&
    !branch.includes('..') &&
    !branch.includes('//') &&
    !branch.endsWith('/') &&
    !branch.endsWith('.') &&
    !branch.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock')) &&
    !ref.startsWith('refs/tags/')
  );
}

export function validateSourceSelection(
  value: unknown,
  declarations?: readonly Pick<SourceDeclaration, 'id'>[],
): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return ['Select a declared source and a pushed branch or main.'];
  const selected = value as Record<string, unknown>;
  const errors: string[] = [];
  if (
    typeof selected.sourceId !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(selected.sourceId)
  )
    errors.push('Select a valid source ID.');
  if (declarations && !declarations.some((source) => source.id === selected.sourceId))
    errors.push('The source is not declared in this farm.');
  if (selected.selection !== 'branch' && selected.selection !== 'main')
    errors.push('Selection must be a pushed branch or main.');
  if (
    selected.selection === 'branch' &&
    (typeof selected.ref !== 'string' || !isSourceBranchRef(selected.ref))
  )
    errors.push('Select a pushed branch, without local paths, tags or commit-only refs.');
  if (selected.selection === 'main' && selected.ref !== undefined && selected.ref !== 'main')
    errors.push('Returning to main cannot select another ref.');
  if (Object.keys(selected).some((key) => !['sourceId', 'selection', 'ref'].includes(key)))
    errors.push('Source selections contain unsupported fields.');
  return errors;
}

export function validateSourceSelections(
  value: unknown,
  declarations?: readonly Pick<SourceDeclaration, 'id'>[],
): string[] {
  if (!Array.isArray(value)) return ['Source selections must be an array.'];
  const errors = value.flatMap((selection) => validateSourceSelection(selection, declarations));
  const ids = value.map((selection) => selection?.sourceId);
  if (new Set(ids).size !== ids.length) errors.push('Select each declared source once.');
  return errors;
}

/** One precedence calculation serves authority locks and all client projections. */
export function selectEffectiveSource(
  source: SourceDeclaration,
  pins: readonly SourcePin[],
  context: Pick<SourceLock['context'], 'runId' | 'nodeId'> = {},
): SourceEffectiveSelection {
  const rank = (pin: SourcePin): number =>
    pin.scope === 'run' && pin.targetId === context.runId
      ? 3
      : pin.scope === 'node' && pin.targetId === context.nodeId
        ? 2
        : pin.scope === 'farm'
          ? 1
          : 0;
  const applicable = pins
    .filter((pin) => pin.sourceId === source.id && rank(pin) > 0)
    .sort((a, b) => rank(b) - rank(a));
  const pin = applicable[0];
  return {
    sourceId: source.id,
    declaredRef: source.ref ?? 'main',
    effectiveRef: pin?.ref ?? source.ref ?? 'main',
    scope: pin?.scope ?? 'farm',
    ...(pin ? { pin: structuredClone(pin) } : {}),
    shadowedPins: structuredClone(applicable.slice(1)),
  };
}
