import type { OkResult } from '../contracts/index.js';

export interface WorkspaceMetroSubscribeParams {
  slotId: string;
  lastN?: number;
}

export type WorkspaceMetroSubscribeResult = OkResult;

export interface WorkspaceMetroUnsubscribeParams {
  slotId: string;
}

export type WorkspaceMetroUnsubscribeResult = OkResult;
