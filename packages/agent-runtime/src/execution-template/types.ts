/** Shared Markdown execution-template catalog (ADR-049). */
import type {
  ExecutionTemplateDefault,
  ExecutionTemplateReference,
  ExecutionTemplateRunMode,
} from '@farmslot/protocol';

export type ExecutionTemplateSourceKind =
  | 'custom'
  | 'project'
  | 'workspace'
  | 'user'
  | 'package'
  | 'fallback';

export type ExecutionTemplateLayout = 'flow-tree' | 'worker-flat';

export type ExecutionRunMode = ExecutionTemplateRunMode;

export interface ExecutionTemplateSource {
  /** Stable source label for catalogs / shadowing (e.g. project:farmslot-farm). */
  id: string;
  kind: ExecutionTemplateSourceKind;
  /** Absolute directory to scan. */
  root: string;
  layout: ExecutionTemplateLayout;
  /** Exact domains supplied by source configuration. */
  domains?: string[];
  /** Git revision of the source root when available. */
  sourceRevision?: string;
  /** True when the source checkout had uncommitted changes. */
  sourceDirty?: boolean;
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
  /** SHA-256 of the source Markdown before rendering. */
  sha256: string;
  sourceRevision?: string;
  sourceDirty?: boolean;
  /** Present when a higher-precedence source already claimed this id. */
  shadowedBy?: string;
  frontmatter: ExecutionTemplateFrontmatter | null;
  heading: string | null;
}

export interface SelectExecutionTemplateOptions {
  sources: ExecutionTemplateSource[];
  flow: string;
  platform: string;
  runMode: ExecutionRunMode;
  domain?: string;
  explicitId?: string;
  defaults?: ExecutionTemplateDefault[];
}

export type ListCompatibleExecutionTemplatesOptions = Omit<
  SelectExecutionTemplateOptions,
  'explicitId' | 'defaults'
>;

export type ExecutionTemplateSelectionReason =
  | 'explicit'
  | 'configured-default'
  | 'single-domain-candidate'
  | 'single-general-candidate';

export interface SelectedExecutionTemplate {
  entry: ExecutionTemplateEntry;
  reason: ExecutionTemplateSelectionReason;
  reference: ExecutionTemplateReference;
}

export type ExecutionTemplateSelectionErrorCode =
  | 'ambiguous'
  | 'missing-or-incompatible'
  | 'no-compatible-template';

export class ExecutionTemplateSelectionError extends Error {
  constructor(
    public readonly code: ExecutionTemplateSelectionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ExecutionTemplateSelectionError';
  }
}

export interface ListExecutionTemplatesOptions {
  sources: ExecutionTemplateSource[];
  flow?: string;
  runMode?: ExecutionRunMode;
  platform?: string;
  /** Keep general templates plus templates for this exact domain. */
  domain?: string;
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
