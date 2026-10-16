import type { PublicationStatus, Run } from '@farmslot/protocol';

export function publicationStatusForRun(run: Run | null | undefined): PublicationStatus {
  return run?.engineState?.publishGate?.publicationStatus ?? 'not_published';
}
