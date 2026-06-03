import type { DispatchQueueAddParams, QueueItem } from '@farmslot/protocol';

export type InternalDispatchQueueAddParams = DispatchQueueAddParams &
  Pick<QueueItem, 'backlogItemId' | 'ticketData'> & { autoDispatch?: boolean };
