// The CLI and gateway share the ordered resolver; only this host driver starts git asynchronously.
import { spawn } from 'node:child_process';

import {
  type ExecutionTemplateGitResult,
  executionTemplateSourceDirtyAsync,
  executionTemplateSourceRevisionAsync,
  resolveConfiguredExecutionTemplateSourcesAsync,
  type ResolveConfiguredExecutionTemplateSourcesOptions,
} from '@farmslot/agent-runtime';
import type { ProjectExecutionTemplatesConfig } from '@farmslot/protocol';

import {
  measureManagedOperation,
  registerHostOperations,
  withHostOperation,
} from '../observability/performance.js';

const operation = 'executionTemplate.sources';
registerHostOperations([operation]);

/** Match source-config's spawnSync: stderr ignored, at most 1 MiB of stdout, no PATH rewrite. */
function runGit(args: string[]): Promise<ExecutionTemplateGitResult> {
  return measureManagedOperation(
    'exec',
    'git',
    () =>
      new Promise((resolve) => {
        const child = spawn('git', args, { stdio: ['ignore', 'pipe', 'ignore'] });
        const output: Buffer[] = [];
        let size = 0;
        let unavailable = false;
        child.stdout.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1024 * 1024) {
            if (!unavailable) child.kill();
            unavailable = true;
          } else output.push(chunk);
        });
        // A failed launch is a null status, which leaves provenance unavailable.
        child.on('error', () => {
          unavailable = true;
        });
        child.on('close', (status) =>
          resolve({
            status: unavailable ? null : status,
            stdout: Buffer.concat(output).toString('utf8'),
          }),
        );
      }),
  );
}

export function executionTemplateSourceRevision(root: string) {
  return withHostOperation(operation, () => executionTemplateSourceRevisionAsync(root, runGit));
}
export function executionTemplateSourceDirty(root: string) {
  return withHostOperation(operation, () => executionTemplateSourceDirtyAsync(root, runGit));
}
export function resolveConfiguredExecutionTemplateSources(
  config: ProjectExecutionTemplatesConfig | undefined,
  options: ResolveConfiguredExecutionTemplateSourcesOptions,
) {
  return withHostOperation(operation, () =>
    resolveConfiguredExecutionTemplateSourcesAsync(config, options, runGit),
  );
}
