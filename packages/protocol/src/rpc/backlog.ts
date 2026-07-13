import type {
  BacklogBlockedItem,
  BacklogCreateInput,
  BacklogEnqueueResultData,
  BacklogItem,
  BacklogStatus,
  BacklogUpdateInput,
} from '../contracts/backlog.js';
import type { OkResult } from '../contracts/index.js';

import { Methods } from './registry.js';

export const BacklogMethods = {
  create: Methods.BACKLOG_CREATE,
  list: Methods.BACKLOG_LIST,
  update: Methods.BACKLOG_UPDATE,
  delete: Methods.BACKLOG_DELETE,
  markReady: Methods.BACKLOG_MARK_READY,
  archive: Methods.BACKLOG_ARCHIVE,
  enqueue: Methods.BACKLOG_ENQUEUE,
  dequeue: Methods.BACKLOG_DEQUEUE,
  autoDispatchTick: Methods.BACKLOG_AUTO_DISPATCH_TICK,
  upcoming: Methods.BACKLOG_UPCOMING,
  specGet: Methods.BACKLOG_SPEC_GET,
} as const;

export interface BacklogCreateParams extends BacklogCreateInput {}
export interface BacklogCreateResult {
  item: BacklogItem;
}

export interface BacklogListParams {
  project?: string;
  status?: BacklogStatus;
  tags?: string[];
  includeArchived?: boolean;
}
export interface BacklogListResult {
  items: BacklogItem[];
}

export interface BacklogUpdateParams extends BacklogUpdateInput {
  itemId: string;
}
export interface BacklogUpdateResult {
  item: BacklogItem;
}

export interface BacklogCloseShippedParams {
  itemId: string;
  /** Merged PR reference (e.g. owner/repo#123 or a PR URL) proving the work shipped. */
  prRef?: string;
  note?: string;
}
export interface BacklogCloseShippedResult {
  item: BacklogItem;
}

export interface BacklogDeleteParams {
  itemId: string;
}
export type BacklogDeleteResult = OkResult;

export interface BacklogMarkReadyParams {
  itemId: string;
}
export interface BacklogMarkReadyResult {
  item: BacklogItem;
}

export interface BacklogArchiveParams {
  itemId: string;
}
export interface BacklogArchiveResult {
  item: BacklogItem;
}

export interface BacklogEnqueueParams {
  itemId: string;
  auto?: boolean;
}
export interface BacklogEnqueueResult extends BacklogEnqueueResultData {}

export interface BacklogDequeueParams {
  itemId: string;
}
export interface BacklogDequeueResult {
  item: BacklogItem;
}

export interface BacklogAutoDispatchTickParams {
  project?: string;
}
export interface BacklogAutoDispatchTickResult {
  enqueued: BacklogEnqueueResultData[];
  blocked: BacklogBlockedItem[];
}

export interface BacklogUpcomingParams {
  project?: string;
  limit?: number;
}
export interface BacklogUpcomingResult {
  ready: BacklogItem[];
  blocked: BacklogBlockedItem[];
}

export interface BacklogSpecGetParams {
  itemId: string;
}
export interface BacklogSpecGetResult {
  itemId: string;
  path: string;
  content: string;
  hash: string;
}
