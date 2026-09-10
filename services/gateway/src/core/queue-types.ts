import type { DispatchQueueAddParams, QueueItem } from '@farmslot/protocol';

export type InternalDispatchQueueAddParams = DispatchQueueAddParams &
  Pick<
    QueueItem,
    | 'backlogItemId'
    | 'prWork'
    | 'workGraphId'
    | 'workNodeId'
    | 'ticketData'
    | 'launchPlanId'
    | 'launchCandidateId'
    | 'launchGroupId'
    | 'launchSlotPolicy'
    | 'launchAttempt'
    | 'executionTemplate'
  > & {
    autoDispatch?: boolean;
  };
