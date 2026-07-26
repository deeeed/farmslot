/** Portable execution-template contracts shared by control planes and workers. */

export type ExecutionTemplateRunMode = 'autonomous' | 'interactive' | 'validation';

export const EXECUTION_TEMPLATE_DOMAIN_LABEL_PREFIX = 'domain:';

export type ConfiguredExecutionTemplateSourceKind = 'workspace' | 'user' | 'package' | 'fallback';

export type ExecutionTemplateSourceRoot =
  | { projectPath: string; env?: never }
  | { env: string; projectPath?: never };

export interface ConfiguredExecutionTemplateSource {
  id: string;
  kind: ConfiguredExecutionTemplateSourceKind;
  root: ExecutionTemplateSourceRoot;
  subpath?: string;
  domains?: string[];
}

export interface ExecutionTemplateDefaultMatch {
  flow?: string;
  platform?: string;
  runMode?: ExecutionTemplateRunMode;
  domain?: string;
}

export interface ExecutionTemplateDefault {
  when: ExecutionTemplateDefaultMatch;
  templateId: string;
}

export interface ProjectExecutionTemplatesConfig {
  sources?: ConfiguredExecutionTemplateSource[];
  defaults?: ExecutionTemplateDefault[];
}

/**
 * Machine-portable identity of the Markdown selected before execution.
 * Absolute source paths and environment values intentionally do not belong here.
 */
export interface ExecutionTemplateReference {
  id: string;
  sourceId: string;
  flow: string;
  runMode?: ExecutionTemplateRunMode;
  platforms: string[];
  labels: string[];
  relativePath: string;
  sourceRevision?: string;
  /** True when the selected source checkout had uncommitted changes. */
  sourceDirty?: boolean;
  /** Present only when explicitly declared by template frontmatter. */
  version?: string;
  /** SHA-256 of the source Markdown before rendering. */
  sha256: string;
  /** SHA-256 of the exact rendered Markdown copied into the task. */
  renderedSha256?: string;
}

export type ExecutionTemplateSourceKind =
  | 'custom'
  | 'project'
  | 'workspace'
  | 'user'
  | 'package'
  | 'fallback';

export interface ExecutionTemplateCatalogOption extends ExecutionTemplateReference {
  title: string;
  sourceKind: ExecutionTemplateSourceKind;
  shadowedBy?: string;
}

export interface UnavailableExecutionTemplateSource {
  id: string;
  reason: 'missing-environment' | 'missing-root' | 'invalid-root';
}

export interface ExecutionTemplateOptions {
  configured: true;
  options: ExecutionTemplateCatalogOption[];
  availableDomains: string[];
  selectedId?: string;
  selectionReason?: string;
  unavailableSources: UnavailableExecutionTemplateSource[];
}
