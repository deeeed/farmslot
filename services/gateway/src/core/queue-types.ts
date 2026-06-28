import type { DispatchQueueAddParams, QueueItem } from '@farmslot/protocol';

export type InternalDispatchQueueAddParams = DispatchQueueAddParams &
  Pick<QueueItem, 'backlogItemId' | 'workGraphId' | 'workNodeId' | 'ticketData'> & {
    autoDispatch?: boolean;
  };
