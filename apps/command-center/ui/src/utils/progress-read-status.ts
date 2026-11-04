import {
  heldDataIsSaved,
  isSupersededRead,
  type ResourceQueryState,
} from '@farmslot/protocol/client-cache';

export interface ProgressReadNotice {
  kind: 'saved' | 'error';
  text: string;
  detail?: string;
}

/** An absent producer or an ordinary reread needs no progress announcement. */
export function progressReadNotice(
  state: ResourceQueryState,
  connected = true,
): ProgressReadNotice | undefined {
  if (
    state.status === 'unsupported' ||
    [
      'RESOURCE_OBSERVATION_UNSUPPORTED',
      'RESOURCE_OBSERVATION_UNAVAILABLE',
      'PROGRESS_OWNER_CHANGED',
    ].includes(state.error?.code ?? '')
  )
    return undefined;
  if (connected && state.error && !isSupersededRead(state.error))
    return { kind: 'error', text: 'Could not read progress', detail: state.error.message };
  if (!heldDataIsSaved(state, connected)) return undefined;
  const data = state.data;
  const markdown = data && typeof data === 'object' ? Reflect.get(data, 'markdown') : undefined;
  const structured = data && typeof data === 'object' ? Reflect.get(data, 'structured') : undefined;
  const total =
    structured && typeof structured === 'object'
      ? Reflect.get(structured, 'totalSteps')
      : undefined;
  const hasProgress =
    typeof total === 'number'
      ? total > 0
      : typeof markdown === 'string' && enumerateChecklistCheckboxes(markdown).length > 0;
  if (hasProgress) return { kind: 'saved', text: 'Saved progress' };
  return undefined;
}
import { enumerateChecklistCheckboxes } from '@farmslot/protocol';
