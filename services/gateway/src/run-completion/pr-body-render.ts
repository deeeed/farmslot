// run-completion/pr-body-render.ts — render the publishable PR body through
// the project's harness before a publication package is built.
//
// The worker writes artifacts/pr-description.md in the repository PR template
// shape; the machine sections (recipe, run log) are inserted by the pack's
// `vars.pr_body_cmd` (for the MetaMask packs, `mm-harness pr-body render`).
// The command runs on the gateway host against the local artifact mirror, so a
// remote slot needs no round trip and the publication step publishes the same
// bytes an engineer gets from the skill. Template conformance is checked
// afterwards by the existing PR template validation.
//
// The rendered body is gateway-owned: it goes to a private temporary `--out`
// file and is returned, never written into the mirror. The mirror's
// artifacts/pr-body.md is the worker's own copy, which every mirror refresh
// replaces, so a body read back from there could be the worker's render.

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { isRecord, type Run } from '@farmslot/protocol';
import { readPoolFiles } from '@farmslot/protocol/node/slot-by-repo';

import {
  getProjectFieldRaw,
  loadProjectVars,
  loadSlotVars,
  poolDir,
  type RawPoolJson,
  SlotConfigError,
} from '../core/config.js';
import { execLocal, type ExecResult, isLocal } from '../core/exec.js';
import { expandTemplate } from '../core/hooks.js';
import { withMachineEnv } from '../core/project-env.js';
import { shellQuote } from '../core/tmux.js';

export const PR_PROSE_ARTIFACT = 'pr-description.md';
export const PR_BODY_ARTIFACT = 'pr-body.md';

export type PrBodyRenderSkip = 'no-task' | 'no-prose' | 'no-slot' | 'no-command';

export interface PrBodyRenderOutcome {
  rendered: boolean;
  /** Why nothing was rendered; absent when rendered. */
  reason?: PrBodyRenderSkip;
  command?: string;
  /** The rendered body; present when rendered. */
  body?: string;
}

export interface PrBodyRenderer {
  /** The expanded `vars.pr_body_cmd`, e.g. `mm-harness pr-body render`. */
  command: string;
  machineEnv?: Record<string, string>;
}

export interface PrBodyRenderDeps {
  exec: (command: string, opts: { cwd: string; timeout: number }) => Promise<ExecResult>;
  /** The pack's renderer for this run's slot, or the reason there is none. */
  resolveRenderer: (run: Run) => Promise<PrBodyRenderer | PrBodyRenderSkip>;
}

export interface PrBodyRendererConfigDeps {
  loadSlotVars: typeof loadSlotVars;
  loadProjectVars: typeof loadProjectVars;
  readPools: () => RawPoolJson[];
}

const rendererConfigDeps: PrBodyRendererConfigDeps = {
  loadSlotVars,
  loadProjectVars,
  readPools: () => readPoolFiles<RawPoolJson>(poolDir).map(({ pool }) => pool),
};

export async function resolvePackRenderer(
  run: Run,
  config: PrBodyRendererConfigDeps = rendererConfigDeps,
): Promise<PrBodyRenderer | PrBodyRenderSkip> {
  if (!run.slotId) return 'no-slot';
  let vars: Awaited<ReturnType<typeof loadSlotVars>>;
  try {
    vars = await config.loadSlotVars(run.slotId);
  } catch (error) {
    if (error instanceof SlotConfigError && error.code === 'SLOT_NOT_FOUND') return 'no-slot';
    throw error;
  }
  const projectVars = await config.loadProjectVars(vars.projectName);
  const raw = projectVars.projectJson.vars?.pr_body_cmd;
  if (typeof raw !== 'string' || !raw.trim()) return 'no-command';
  // Rendering executes on the gateway host; remote node paths never apply here.
  const local = isLocal(vars.host, vars.machine);
  const rootEnv = getProjectFieldRaw(projectVars.projectJson, 'recipe.provider.root.env');
  let machineEnv = local ? vars.machineEnv : undefined;
  if (rootEnv !== undefined) {
    if (typeof rootEnv !== 'string' || !rootEnv.trim()) {
      throw new Error('PR body provider root must name its configured environment key');
    }
    const roots = new Set(
      (local
        ? [vars.machineEnv?.[rootEnv]]
        : config
            .readPools()
            .filter((pool) => isLocal(pool.host, pool.machine))
            .map((pool) => pool.env?.[rootEnv])
      ).filter((value): value is string => typeof value === 'string' && value.trim().length > 0),
    );
    if (roots.size !== 1) {
      throw new Error(
        `PR body rendering requires one gateway-host provider root in pool.env.${rootEnv}; found ${roots.size}`,
      );
    }
    machineEnv = { ...machineEnv, [rootEnv]: [...roots][0] };
  }
  return {
    command: expandTemplate(raw, vars, projectVars),
    ...(machineEnv ? { machineEnv } : {}),
  };
}

const defaultDeps: PrBodyRenderDeps = {
  exec: (command, opts) => execLocal(command, opts),
  resolveRenderer: resolvePackRenderer,
};

let depsOverride: PrBodyRenderDeps | null = null;

/** Replace the renderer's exec and pack lookup in tests; null restores them. */
export function __setPrBodyRenderDepsForTest(deps: PrBodyRenderDeps | null): void {
  depsOverride = deps;
}

function renderFailureMessage(result: ExecResult): string {
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    const error = isRecord(parsed) ? parsed.error : undefined;
    const message =
      typeof error === 'string'
        ? error
        : isRecord(error) && typeof error.message === 'string'
          ? error.message
          : undefined;
    if (message?.trim()) return message.trim();
  } catch {
    // Not a JSON envelope; the raw streams carry the message.
  }
  return result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
}

/**
 * Run the pack's PR body renderer against the run's local task directory and
 * return the rendered body. Returns without rendering when the run has no
 * task, no authored prose, no slot, or the pack declares no
 * `vars.pr_body_cmd`; throws when the renderer itself fails, carrying its
 * message. Nothing is written into the task directory.
 */
export async function renderPrBody(
  run: Run,
  deps: PrBodyRenderDeps = depsOverride ?? defaultDeps,
): Promise<PrBodyRenderOutcome> {
  if (!run.taskFile) return { rendered: false, reason: 'no-task' };
  const taskDir = path.dirname(run.taskFile);
  if (!existsSync(path.join(taskDir, 'artifacts', PR_PROSE_ARTIFACT))) {
    return { rendered: false, reason: 'no-prose' };
  }
  const renderer = await deps.resolveRenderer(run);
  if (typeof renderer === 'string') return { rendered: false, reason: renderer };

  const outDir = await mkdtemp(path.join(tmpdir(), 'farmslot-pr-body-'));
  try {
    const out = path.join(outDir, PR_BODY_ARTIFACT);
    const command = withMachineEnv(
      [renderer.command, shellQuote(taskDir), '--out', shellQuote(out), '--json'].join(' '),
      renderer,
    );
    const result = await deps.exec(command, { cwd: taskDir, timeout: 60_000 });
    if (result.exitCode !== 0) {
      throw new Error(`PR body render failed: ${renderFailureMessage(result)}`);
    }
    return { rendered: true, command: renderer.command, body: await readFile(out, 'utf-8') };
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}
