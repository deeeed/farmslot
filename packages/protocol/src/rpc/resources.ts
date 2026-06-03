import type { OkResult } from '../contracts/index.js';

import { Methods } from './registry.js';

export const ResourceMethods = {
  list: Methods.RESOURCE_LIST,
  control: Methods.RESOURCE_CONTROL,
  health: Methods.RESOURCE_HEALTH,
  streamSubscribe: Methods.STREAM_SUBSCRIBE,
  streamUnsubscribe: Methods.STREAM_UNSUBSCRIBE,
  streamSnapshot: Methods.STREAM_SNAPSHOT,
  screenSubscribe: Methods.SCREEN_SUBSCRIBE,
  screenUnsubscribe: Methods.SCREEN_UNSUBSCRIBE,
  screenThumbnail: Methods.SCREEN_THUMBNAIL,
} as const;

// ─── Node Health param/result types ───

export interface NodeHealthParams {
  machine: string;
}

export interface NodeHealthResult {
  health: import('../contracts/index.js').MachineHealth;
}

export interface NodeHealthAllResult {
  machines: import('../contracts/index.js').MachineHealth[];
}

// ─── Screen Thumbnail param/result types ───

export interface ScreenThumbnailParams {
  slotId: string;
  platform?: string;
  maxWidth?: number;
}

export interface ScreenThumbnailResult {
  data: string; // base64 PNG
  width: number;
  height: number;
  timestamp: number;
}

export interface StreamSubscribeParams {
  slotId: string;
  platform?: string;
  resourceId?: string;
  maxFps?: number;
  maxWidth?: number;
}

export type StreamSubscribeResult = OkResult & { resourceIndex?: number };

export interface StreamUnsubscribeParams {
  slotId: string;
  platform?: string;
  resourceId?: string;
}

export interface StreamSnapshotParams {
  slotId: string;
}

export interface StreamSnapshotResult {
  data: string; // base64 PNG
}
export interface ScreenSubscribeParams {
  slotId: string;
  platform: string;
  maxFps?: number;
  maxSize?: number;
  iosWindowName?: string;
  androidSerial?: string;
  browserPid?: number;
}

export interface ScreenUnsubscribeParams {
  slotId: string;
}
export interface ResourceListParams {
  slotId: string;
}

export interface ResourceListResult {
  resources: import('../contracts/index.js').SlotResource[];
}

export type ResourceControlAction = 'boot' | 'shutdown' | 'relaunch';

export interface ResourceControlParams {
  slotId: string;
  resourceId: string;
  action: ResourceControlAction;
}

export interface ResourceControlResult {
  ok: boolean;
  detail?: string;
}

export interface ResourceHealthParams {
  slotId: string;
}

export interface ResourceHealthResult {
  slotId: string;
  resources: import('../contracts/index.js').ResourceStateUpdate[];
}
