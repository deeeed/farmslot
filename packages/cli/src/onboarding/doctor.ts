// onboarding/doctor.ts — health checks for an installed farmslot workspace.
// Standalone `farmslot doctor`; install.sh / project add / update all end with it.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readlinkSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { readPool } from './pool-config.js';
import { checkPrereqs, detectRunners, runnerHint } from './prereqs.js';
import { readState, type Workspace, type WorkspaceState } from './workspace.js';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail?: string;
  hint?: string;
}

export interface DoctorSection {
  title: string;
  checks: DoctorCheck[];
}

export interface DoctorReport {
  sections: DoctorSection[];
  ok: boolean;
}

function prereqSection(): DoctorSection {
  const checks = checkPrereqs().map((p) => ({
    name: p.name,
    ok: p.ok,
    detail: p.detail,
    hint: p.hint,
  }));
  return { title: 'Prerequisites', checks };
}

function runnerSection(): DoctorSection {
  const runners = detectRunners();
  const checks: DoctorCheck[] = runners.map((r) => ({
    name: r.name,
    ok: r.found,
    detail: r.found ? 'on PATH' : 'not found',
    hint: r.found ? undefined : runnerHint(r.name),
  }));
  const anyFound = runners.some((r) => r.found);
  if (!anyFound) {
    checks.push({
      name: 'at least one runner',
      ok: false,
      detail: 'no agent runner found',
      hint: 'install one of: claude, codex, cursor-agent',
    });
  } else {
    // Individual missing runners are informational once one runner exists.
    for (const check of checks) if (!check.ok) check.ok = true;
    checks.push({ name: 'at least one runner', ok: true, detail: 'ok' });
  }
  return { title: 'Runners', checks };
}

function workspaceSection(ws: Workspace | null): {
  section: DoctorSection;
  state: WorkspaceState | null;
} {
  if (!ws) {
    return {
      section: {
        title: 'Workspace',
        checks: [
          {
            name: 'workspace',
            ok: false,
            detail: 'no workspace found',
            hint: 'set FARMSLOT_WORKSPACE or run install.sh',
          },
        ],
      },
      state: null,
    };
  }
  const checks: DoctorCheck[] = [];
  for (const [name, dir] of [
    ['farmslot clone', ws.farmslotDir],
    ['repos dir', ws.reposDir],
    ['runs dir', ws.runsDir],
  ] as const) {
    checks.push({
      name,
      ok: existsSync(dir),
      detail: dir,
      hint: existsSync(dir) ? undefined : 're-run install.sh to repair the workspace layout',
    });
  }
  let state: WorkspaceState | null = null;
  try {
    state = readState(ws);
    checks.push({
      name: 'state file',
      ok: state !== null,
      detail: ws.statePath,
      hint: state === null ? 're-run install.sh to initialize state.json' : undefined,
    });
  } catch (err) {
    checks.push({
      name: 'state file',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
      hint: 're-run install.sh to repair state.json',
    });
  }
  return { section: { title: 'Workspace', checks }, state };
}

function poolSection(ws: Workspace | null, state: WorkspaceState | null): DoctorSection {
  if (!ws || !state) {
    return {
      title: 'Pool',
      checks: [{ name: 'pool config', ok: false, detail: 'skipped (no workspace state)' }],
    };
  }
  const poolPath = join(ws.farmslotDir, state.pool_file);
  if (!existsSync(poolPath)) {
    return {
      title: 'Pool',
      checks: [
        {
          name: 'pool config',
          ok: false,
          detail: `${poolPath} not found`,
          hint: 're-run install.sh to generate the pool file',
        },
      ],
    };
  }
  try {
    const pool = readPool(poolPath);
    return {
      title: 'Pool',
      checks: [
        {
          name: 'pool config',
          ok: true,
          detail: `${state.pool_file} (machine ${pool.machine}, ${pool.slots.length} slot${pool.slots.length === 1 ? '' : 's'}, schema v${pool.schema_version ?? 0})`,
        },
      ],
    };
  } catch (err) {
    return {
      title: 'Pool',
      checks: [
        {
          name: 'pool config',
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
          hint: 'fix the listed fields or re-run farmslot update',
        },
      ],
    };
  }
}

function packSection(ws: Workspace | null, state: WorkspaceState | null): DoctorSection {
  if (!ws || !state) {
    return {
      title: 'Packs',
      checks: [{ name: 'packs', ok: false, detail: 'skipped (no workspace state)' }],
    };
  }
  const names = Object.keys(state.packs);
  if (names.length === 0) {
    return {
      title: 'Packs',
      checks: [
        { name: 'packs', ok: true, detail: 'none registered (farmslot project add <pack>)' },
      ],
    };
  }
  const checks: DoctorCheck[] = [];
  const poolPath = join(ws.farmslotDir, state.pool_file);
  let slotIds = new Set<string>();
  try {
    slotIds = new Set(readPool(poolPath).slots.map((s) => s.id));
  } catch {
    // Pool problems are reported by the Pool section; here they just surface as missing slots.
  }
  for (const name of names) {
    const pack = state.packs[name];
    const problems: string[] = [];
    for (const project of pack.projects) {
      if (!existsSync(join(ws.farmslotDir, 'projects', project, 'project.json'))) {
        problems.push(`project '${project}' not registered`);
      }
    }
    for (const slotId of pack.slots) {
      if (!slotIds.has(slotId)) problems.push(`slot '${slotId}' missing from pool`);
    }
    checks.push({
      name,
      ok: problems.length === 0,
      detail:
        problems.length === 0
          ? `${pack.projects.length} project(s), ${pack.slots.length} slot(s)`
          : problems.join('; '),
      hint: problems.length === 0 ? undefined : `re-run: farmslot project add ${pack.source}`,
    });
  }
  return { title: 'Packs', checks };
}

function cliSection(ws: Workspace | null): DoctorSection {
  const checks: DoctorCheck[] = [];
  const root = ws?.farmslotDir;
  if (!root) {
    return { title: 'CLI', checks: [{ name: 'cli', ok: false, detail: 'skipped (no workspace)' }] };
  }
  const nodeModules = join(root, 'node_modules');
  const depsInstalled = existsSync(nodeModules);
  checks.push({
    name: 'dependencies installed',
    ok: depsInstalled,
    detail: depsInstalled ? nodeModules : 'node_modules missing',
    hint: depsInstalled ? undefined : `run: yarn --cwd ${root} install`,
  });
  if (depsInstalled) {
    const lock = join(root, 'yarn.lock');
    const stateFile = join(nodeModules, '.yarn-state.yml');
    const fresh =
      existsSync(lock) &&
      existsSync(stateFile) &&
      statSync(stateFile).mtimeMs >= statSync(lock).mtimeMs;
    checks.push({
      name: 'install fresh',
      ok: fresh,
      detail: fresh ? 'node_modules newer than yarn.lock' : 'yarn.lock changed since last install',
      hint: fresh ? undefined : 'run: farmslot update',
    });
  }
  const which = spawnSync('command', ['-v', 'farmslot'], { encoding: 'utf-8', shell: '/bin/bash' });
  const binPath = which.status === 0 ? which.stdout.trim() : null;
  if (!binPath) {
    checks.push({
      name: 'farmslot on PATH',
      ok: false,
      detail: 'not found',
      hint: 're-run install.sh to create the PATH symlink',
    });
  } else {
    let target = binPath;
    if (lstatSync(binPath).isSymbolicLink())
      target = resolve(join(binPath, '..'), readlinkSync(binPath));
    const pointsHere = target.startsWith(root);
    checks.push({
      name: 'farmslot on PATH',
      ok: pointsHere,
      detail: pointsHere ? binPath : `${binPath} -> ${target} (outside this workspace)`,
      hint: pointsHere ? undefined : 're-run install.sh to repoint the symlink',
    });
  }
  return { title: 'CLI', checks };
}

export function runDoctor(ws: Workspace | null): DoctorReport {
  const { section: workspace, state } = workspaceSection(ws);
  const sections = [
    prereqSection(),
    runnerSection(),
    workspace,
    poolSection(ws, state),
    packSection(ws, state),
    cliSection(ws),
  ];
  return { sections, ok: sections.every((s) => s.checks.every((c) => c.ok)) };
}
