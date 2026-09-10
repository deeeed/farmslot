import type {
  PRExecutionProfile,
  PRMonitor,
  PRMonitorConfig,
  PRProjectMonitorPolicy,
} from '../contracts/pr-monitoring.js';

export interface PRWatchListResult {
  monitors: PRMonitor[];
  schedulerError?: string;
  projectPolicies?: PRProjectMonitorPolicy[];
  publicationErrors?: Record<string, string>;
}
export interface PRWatchSubscribeParams {
  config: PRMonitorConfig;
}
export interface PRWatchGetParams {
  id: string;
}
export interface PRWatchConfigureParams extends PRWatchSubscribeParams, PRWatchGetParams {
  revision: number;
}
export interface PRWatchLifecycleParams extends PRWatchGetParams {
  revision: number;
  lifecycle: 'active' | 'paused' | 'stopped';
}
export interface PRWatchAcknowledgeParams extends PRWatchGetParams {
  revision: number;
  incidentId: string;
  snoozedUntil?: string;
}
export interface PRWatchResult {
  monitor: PRMonitor;
}
export interface PRWatchRepairParams extends PRWatchGetParams {
  revision: number;
  project?: string;
  execution?: PRExecutionProfile;
}
export interface PRWatchProjectPolicySetParams {
  project: string;
  enabled: boolean;
  config: PRProjectMonitorPolicy['config'];
  revision?: number;
}
export interface PRWatchProjectPolicySetResult {
  policy: PRProjectMonitorPolicy;
}
