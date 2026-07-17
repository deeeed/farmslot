/** Shared Markdown execution-template catalog (ADR-049). */

export type ExecutionTemplateSourceKind =
  | 'custom'
  | 'project'
  | 'workspace'
  | 'user'
  | 'package'
  | 'fallback';

export type ExecutionTemplateLayout = 'flow-tree' | 'worker-flat';

export type ExecutionRunMode = 'autonomous' | 'interactive' | 'validation';

export interface ExecutionTemplateSource {
  /** Stable source label for catalogs / shadowing (e.g. project:metamask-mobile-farm). */
  id: string;
  kind: ExecutionTemplateSourceKind;
  /** Absolute directory to scan. */
  root: string;
  layout: ExecutionTemplateLayout;
}

export interface ExecutionTemplateFrontmatter {
  id?: string;
  title?: string;
  flow?: string;
  version?: string | number;
  runMode?: ExecutionRunMode;
  platforms?: string[];
  labels?: string[];
  [key: string]: unknown;
}

export interface ExecutionTemplateEntry {
  id: string;
  title: string;
  flow: string;
  version: string;
  runMode: ExecutionRunMode | null;
  platforms: string[];
  labels: string[];
  path: string;
  relativePath: string;
  sourceId: string;
  sourceKind: ExecutionTemplateSourceKind;
  /** Present when a higher-precedence source already claimed this id. */
  shadowedBy?: string;
  frontmatter: ExecutionTemplateFrontmatter | null;
  heading: string | null;
}

export interface ListExecutionTemplatesOptions {
  sources: ExecutionTemplateSource[];
  flow?: string;
  runMode?: ExecutionRunMode;
  platform?: string;
  /** Include shadowed duplicates (default true for list diagnostics). */
  includeShadowed?: boolean;
}

export interface LintIssue {
  path: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface LintExecutionTemplatesResult {
  ok: boolean;
  issues: LintIssue[];
  filesChecked: number;
}

export interface CreateExecutionTemplateOptions {
  path: string;
  flow?: string;
  runMode?: ExecutionRunMode;
  platforms?: string[];
  title?: string;
  force?: boolean;
}
