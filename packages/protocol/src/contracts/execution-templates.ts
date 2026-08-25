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
  /** Short guidance explaining when an operator should select this template. */
  description?: string;
  sourceKind: ExecutionTemplateSourceKind;
  /**
   * Source-level domain gate copied from the catalog source. Absent or empty
   * means the source participates for every domain. Clients that filter a
   * full catalog locally use this together with `labels`.
   */
  sourceDomains?: string[];
}

export interface UnavailableExecutionTemplateSource {
  id: string;
  reason: 'missing-environment' | 'missing-root' | 'invalid-root';
}

/**
 * A configured source that resolved fine but sat out this query because it is
 * restricted to domains the caller did not request. Distinct from
 * `unavailableSources` (root-resolution failures): these sources exist and
 * would participate for one of the listed domains.
 */
export interface DomainRestrictedExecutionTemplateSource {
  id: string;
  reason: 'domain-restricted';
  /** Requesting any of these domains makes the source participate. */
  domains: string[];
}

export interface ExecutionTemplateOptions {
  configured: true;
  options: ExecutionTemplateCatalogOption[];
  availableDomains: string[];
  selectedId?: string;
  selectionReason?: string;
  unavailableSources: UnavailableExecutionTemplateSource[];
  /** Sources dropped by the domain gate for this query — never silently hidden. */
  filteredSources: DomainRestrictedExecutionTemplateSource[];
  /** Configured selection defaults from the project pack. Present on full catalogs. */
  defaults?: ExecutionTemplateDefault[];
}
