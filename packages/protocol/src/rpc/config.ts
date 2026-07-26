import type {
  ExecutionTemplateOptions,
  ExecutionTemplateRunMode,
  FlowType,
  PoolConfig,
  ProjectAutoRecoveryConfig,
  ProjectBacklogConfig,
  ProjectConfig,
  SlotConfigUpdate,
  TemplatePreview,
  WorkerTemplateOption,
} from '../contracts/index.js';

import { Methods } from './registry.js';

export const ConfigMethods = {
  pools: Methods.CONFIG_POOLS,
  pool: Methods.CONFIG_POOL,
  projects: Methods.CONFIG_PROJECTS,
  project: Methods.CONFIG_PROJECT,
  poolRaw: Methods.CONFIG_POOL_RAW,
  templates: Methods.CONFIG_TEMPLATES,
  templatePreview: Methods.CONFIG_TEMPLATE_PREVIEW,
  templateOptions: Methods.CONFIG_TEMPLATE_OPTIONS,
  slotUpdate: Methods.CONFIG_SLOT_UPDATE,
  poolUpdate: Methods.CONFIG_POOL_UPDATE,
  projectAutoRecoveryUpdate: Methods.CONFIG_PROJECT_AUTO_RECOVERY_UPDATE,
  projectBacklogUpdate: Methods.CONFIG_PROJECT_BACKLOG_UPDATE,
} as const;

export interface ConfigPoolParams {
  machine: string;
}

export interface ConfigPoolResult {
  pool: PoolConfig;
}

export interface ConfigPoolRawResult {
  raw: string;
}

export interface ConfigProjectParams {
  project: string;
}

export interface ProjectLearningsDocument {
  exists: boolean;
  relativePath: string;
  content: string;
  updatedAt: string | null;
  sizeBytes: number | null;
}

export interface ConfigProjectResult {
  project: ProjectConfig;
  learnings: ProjectLearningsDocument;
}

export interface ConfigTemplatesParams {
  project: string;
}

export interface ConfigTemplatesResult {
  templates: TemplatePreview[];
}

export interface ConfigTemplatePreviewParams {
  project: string;
  flowType: string;
}

export interface ConfigTemplatePreviewResult {
  template: TemplatePreview;
}

export interface ConfigTemplateOptionsParams {
  project: string;
  flowType: FlowType;
  platform?: string;
  runMode?: ExecutionTemplateRunMode;
  domain?: string;
  executionTemplateId?: string;
}

export interface ConfigTemplateOptionsResult {
  options: WorkerTemplateOption[];
  /** Present only when the project opts into the shared configured catalog. */
  executionTemplates?: ExecutionTemplateOptions;
}

export interface ConfigSlotUpdateParams {
  slotId: string;
  update: SlotConfigUpdate;
}

export interface ConfigSlotUpdateResult {
  ok: boolean;
}

export interface ConfigPoolUpdateParams {
  machine: string;
  content: string;
}

export interface ConfigPoolUpdateResult {
  ok: boolean;
  backup: string;
}

export interface ConfigProjectAutoRecoveryUpdateParams {
  project: string;
  autoRecovery: ProjectAutoRecoveryConfig;
}

export interface ConfigProjectAutoRecoveryUpdateResult {
  ok: boolean;
  backup: string;
  project: ProjectConfig;
}

export interface ConfigProjectBacklogUpdateParams {
  project: string;
  backlog: ProjectBacklogConfig;
}

export interface ConfigProjectBacklogUpdateResult {
  ok: boolean;
  backup: string;
  project: ProjectConfig;
}
export interface ConfigPoolsResult {
  pools: PoolConfig[];
}

export interface ConfigProjectsResult {
  projects: ProjectConfig[];
}
