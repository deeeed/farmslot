import type { ExecutionTemplateSourceRoot } from './execution-templates.js';

export interface ReviewWorkspaceSupportSource {
  name: string;
  root: ExecutionTemplateSourceRoot;
  subpath?: string;
}
export interface ReviewWorkspaceSupportEntry extends ReviewWorkspaceSupportSource {
  entry: string;
}
/** Trusted farm configuration. This contract accepts files and installed packages, never commands. */
export interface ReviewWorkspaceSupportConfig {
  skills?: ReviewWorkspaceSupportEntry[];
  libraries?: ReviewWorkspaceSupportSource[];
  runtime?: ReviewWorkspaceSupportEntry;
  environment?: Record<string, string>;
}
export interface ReviewWorkspaceSupportBinding {
  /** Immutable node cache outside the run's source and writable output roots. */
  path: string;
  sha256: string;
  sources: Array<{
    kind: 'skill' | 'library' | 'runtime';
    name: string;
    sourceRevision?: string;
    sourceDirty?: boolean;
    packageName?: string;
    packageVersion?: string;
  }>;
  skills: Array<{ name: string; path: string }>;
  runtime?: { name: string; path: string };
  /** Literal configuration with {{support}} bound at native launch. Never credentials. */
  environment: Record<string, string>;
}

/** Operator-selected machine for a static review without a slot. */
export interface ReviewWorkspaceTarget {
  machine: string;
}

/** Immutable PR inputs captured before a workspace reviewer starts. */
export interface ReviewWorkspaceSubject {
  repository: string;
  repositoryUrl: string;
  headSha: string;
  baseSha: string;
  branch: string;
  title: string;
  body: string;
  capturedAt: string;
  url?: string;
}

/** Trusted binding created by the execution runtime, never supplied by a caller. */
export interface ReviewWorkspaceBinding {
  workspaceId: string;
  machine: string;
  executionNodeId: string;
  checkoutPath: string;
  taskPath: string;
  artifactPath: string;
  support?: ReviewWorkspaceSupportBinding;
  /** Node receipt confirms the source checkout was removed; task/report paths remain. */
  cleanedAt?: string;
}
