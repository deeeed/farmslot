// run-completion/pr-body-render.ts — render artifacts/pr-body.md through the
// project's harness before a publication package is built.
//
// The worker authors only the prose sections of the repository PR template in
// artifacts/pr-description.md; the machine sections (recipe, run log) are
// rendered by the pack's `vars.pr_body_cmd` (for the MetaMask packs,
// `mm-harness pr-body render`). The command runs on the gateway host against
// the local artifact mirror, with the PR template the gateway already fetched
// from the slot, so a remote slot needs no round trip and the publication step
// publishes the same bytes an engineer gets from the skill.

import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Run } from '@farmslot/protocol';

import { loadProjectVars, loadSlotVars, SlotConfigError } from '../core/config.js';
import { execLocal, type ExecResult, isLocal } from '../core/exec.js';
import { expandTemplate } from '../core/hooks.js';
import { withMachineEnv } from '../core/project-env.js';
import { shellQuote } from '../core/tmux.js';

import { readRepositoryPrTemplate, type RepositoryPrTemplate } from './pr-template.js';

export const PR_PROSE_ARTIFACT = 'pr-description.md';
export const PR_BODY_ARTIFACT = 'pr-body.md';

export type PrBodyRenderSkip = 'no-task' | 'no-prose' | 'no-slot' | 'no-command';

export interface PrBodyRenderOutcome {
  rendered: boolean;
  /** Why nothing was rendered; absent when rendered. */
  reason?: PrBodyRenderSkip;
  command?: string;
}

export interface PrBodyRenderer {
  /** The expanded `vars.pr_body_cmd`, e.g. `mm-harness pr-body render`. */
  command: string;
  machineEnv?: Record<string, string>;
}

export interface PrBodyRenderDeps {
  exec: (command: string, opts: { cwd: string; timeout: number }) => Promise<ExecResult>;
  readTemplate: (run: Run, baseBranch?: string) => Promise<RepositoryPrTemplate | null>;
  /** The pack's renderer for this run's slot, or the reason there is none. */
  resolveRenderer: (run: Run) => Promise<PrBodyRenderer | PrBodyRenderSkip>;
}

async function resolvePackRenderer(run: Run): Promise<PrBodyRenderer | PrBodyRenderSkip> {
  if (!run.slotId) return 'no-slot';
  let vars: Awaited<ReturnType<typeof loadSlotVars>>;
  try {
    vars = await loadSlotVars(run.slotId);
  } catch (error) {
    if (error instanceof SlotConfigError && error.code === 'SLOT_NOT_FOUND') return 'no-slot';
    throw error;
  }
  const projectVars = await loadProjectVars(vars.projectName);
  const raw = projectVars.projectJson.vars?.pr_body_cmd;
  if (typeof raw !== 'string' || !raw.trim()) return 'no-command';
  // The renderer runs on the gateway host, so a remote slot's machine env (for
  // example a remote MM_HARNESS_BIN path) must not be applied; the host's PATH
  // resolves the harness there.
  const local = isLocal(vars.host, vars.machine);
  return {
    command: expandTemplate(raw, vars, projectVars),
    ...(local && vars.machineEnv ? { machineEnv: vars.machineEnv } : {}),
  };
}

const defaultDeps: PrBodyRenderDeps = {
  exec: (command, opts) => execLocal(command, opts),
  readTemplate: readRepositoryPrTemplate,
  resolveRenderer: resolvePackRenderer,
};

function renderFailureMessage(result: ExecResult): string {
  try {
    const parsed = JSON.parse(result.stdout) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error.trim();
  } catch {
    // Not a JSON envelope; the raw streams carry the message.
  }
  return result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
}

/**
 * Run the pack's PR body renderer against the run's local task directory.
 * Returns without rendering when the run has no task, no authored prose, no
 * slot, or the pack declares no `vars.pr_body_cmd`; throws when the renderer
 * itself fails, carrying its message (typically the prose section it misses).
 */
export async function renderPrBodyArtifact(
  run: Run,
  baseBranch?: string,
  deps: PrBodyRenderDeps = defaultDeps,
): Promise<PrBodyRenderOutcome> {
  if (!run.taskFile) return { rendered: false, reason: 'no-task' };
  const taskDir = path.dirname(run.taskFile);
  if (!existsSync(path.join(taskDir, 'artifacts', PR_PROSE_ARTIFACT))) {
    return { rendered: false, reason: 'no-prose' };
  }
  const renderer = await deps.resolveRenderer(run);
  if (typeof renderer === 'string') return { rendered: false, reason: renderer };

  const template = await deps.readTemplate(run, baseBranch);
  const scratch = await mkdtemp(path.join(tmpdir(), 'farmslot-pr-template-'));
  try {
    const templateFile = path.join(scratch, 'pull-request-template.md');
    await writeFile(templateFile, template?.body ?? '', 'utf-8');
    const command = withMachineEnv(
      [
        renderer.command,
        shellQuote(taskDir),
        '--template',
        shellQuote(templateFile),
        ...(template ? ['--template-path', shellQuote(template.path)] : []),
        '--json',
      ].join(' '),
      renderer,
    );
    const result = await deps.exec(command, { cwd: taskDir, timeout: 60_000 });
    if (result.exitCode !== 0) {
      throw new Error(`PR body render failed: ${renderFailureMessage(result)}`);
    }
    return { rendered: true, command: renderer.command };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
