import type { RunReplayStepParams } from '../rpc/run.js';

import type { ExecutionTemplateSourceRoot } from './execution-templates.js';
import { PipelineSteps, type Run } from './runs.js';

export function staticReviewReplayBlock(
  run: Pick<Run, 'reviewWorkspaceTarget' | 'reviewWorkspace' | 'agentContexts'>,
  params: Pick<RunReplayStepParams, 'stepName' | 'runner' | 'model' | 'freshDispatch'>,
): string | null {
  if (!run.reviewWorkspaceTarget) return null;
  const ownsAttempt = Boolean(
    run.reviewWorkspace || run.agentContexts?.some((context) => context.id === 'review'),
  );
  if (
    ownsAttempt &&
    (params.runner !== undefined || params.model !== undefined || params.freshDispatch)
  )
    return 'A different reviewer requires a new review request. The current attempt, runner and artifacts have not been changed.';
  const launchSteps: readonly string[] = [
    PipelineSteps.FIND_SLOT,
    PipelineSteps.WRITE_TASK,
    PipelineSteps.PREPARE,
    PipelineSteps.DISPATCH,
  ];
  if (ownsAttempt && launchSteps.includes(params.stepName))
    return 'This static review already owns a workspace. Request another review instead of replaying setup or dispatch.';
  if (params.stepName === 'monitor' && !run.reviewWorkspace)
    return 'This static review has no workspace to resume. Request another review.';
  return null;
}

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
  /** Literal configuration with {{support}} and {{<key>_repo}} bound at native launch. Never credentials. */
  environment: Record<string, string>;
  /** Consumer checkouts read at these revisions on the execution node. */
  references?: Array<{
    name: string;
    path: string;
    headSha?: string;
    dirty?: boolean;
    missing?: true;
  }>;
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
