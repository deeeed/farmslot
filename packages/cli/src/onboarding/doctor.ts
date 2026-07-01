// onboarding/doctor.ts — health checks for an installed farmslot workspace.
// Standalone `farmslot doctor`; install.sh / project add / update all end with it.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readlinkSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { captureHelperPath } from '@farmslot/protocol/node/capture-helper-path';
import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

import { probeGatewayAuth } from '../gateway-auth.js';
import { loadProfiles, profileCredential, profilesPath } from '../gateway-profiles.js';

import { readPool } from './pool-config.js';
import { checkPrereqs, commandPath, detectRunners, runnerHint } from './prereqs.js';
import { readState, type Workspace, type WorkspaceState } from './workspace.js';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  /** True for non-fatal findings: shown as WARN, does not fail the report. */
  warn?: boolean;
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
  const anyAuthenticated = runners.some((r) => r.status === 'authenticated');
  // Individual runner problems stay visible as warnings once the ≥1
  // authenticated gate passes; the gate check carries the failure.
  const checks: DoctorCheck[] = runners.map((r) => ({
    name: r.name,
    ok: anyAuthenticated || r.status === 'authenticated',
    warn: r.status !== 'authenticated',
    detail:
      r.status === 'authenticated'
        ? 'authenticated'
        : r.status === 'inactive'
          ? 'on PATH but not signed in'
          : 'not found',
    hint: r.status === 'authenticated' ? undefined : runnerHint(r.name, r.status),
  }));
  checks.push({
    name: 'at least one authenticated runner',
    ok: anyAuthenticated,
    detail: anyAuthenticated
      ? runners
          .filter((r) => r.status === 'authenticated')
          .map((r) => r.name)
          .join(', ')
      : 'no authenticated agent runner',
    hint: anyAuthenticated
      ? undefined
      : 'install and sign in to one of: claude, codex, cursor-agent, grok',
  });
  return { title: 'Runners', checks };
}

function workspaceSection(ws: Workspace | null): {
  section: DoctorSection;
  state: WorkspaceState | null;
} {
  if (!ws) {
    // Plain dev checkout / legacy machine: prereq + runner health still matters,
    // a missing workspace is advice, not breakage.
    return {
      section: {
        title: 'Workspace',
        checks: [
          {
            name: 'workspace',
            ok: true,
            warn: true,
            detail: 'no workspace found (dev checkout mode)',
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
  const resolvedHome = farmslotHome();
  // Compare via the shared resolver (expands tilde) + resolve() so a trailing slash or a
  // tilde/relative persisted value is not a false divergence.
  const homeMismatch =
    state?.home_dir != null &&
    resolve(farmslotHome({ FARMSLOT_HOME: state.home_dir } as NodeJS.ProcessEnv)) !==
      resolve(resolvedHome);
  checks.push({
    name: 'home',
    ok: true,
    warn: homeMismatch,
    detail: homeMismatch
      ? `${resolvedHome} (install-time home was ${state?.home_dir})`
      : resolvedHome,
    hint: homeMismatch
      ? 'FARMSLOT_HOME overrides the install-time home; unset it or re-run install.sh to realign'
      : undefined,
  });
  return { section: { title: 'Workspace', checks }, state };
}

function poolSection(ws: Workspace | null, state: WorkspaceState | null): DoctorSection {
  if (!ws || !state) {
    return {
      title: 'Pool',
      checks: [
        {
          name: 'pool config',
          ok: !ws,
          warn: !ws,
          detail: ws ? 'skipped (no workspace state)' : 'skipped (dev checkout mode)',
        },
      ],
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
      checks: [
        {
          name: 'packs',
          ok: !ws,
          warn: !ws,
          detail: ws ? 'skipped (no workspace state)' : 'skipped (dev checkout mode)',
        },
      ],
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
  } catch (err) {
    // The Pool section reports the root cause; record it here so pack checks
    // explain WHY every slot looks missing instead of silently failing.
    checks.push({
      name: 'pool readable',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
      hint: 'fix the pool config (see the Pool section)',
    });
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

/** Path-boundary-safe containment: /a/b contains /a/b and /a/b/c, not /a/bc. */
function isInside(target: string, root: string): boolean {
  return target === root || target.startsWith(root + sep);
}

function cliSection(ws: Workspace | null, state: WorkspaceState | null): DoctorSection {
  const checks: DoctorCheck[] = [];
  const root = ws?.farmslotDir;
  if (!root) {
    return {
      title: 'CLI',
      checks: [{ name: 'cli', ok: true, warn: true, detail: 'skipped (dev checkout mode)' }],
    };
  }
  const nodeModules = join(root, 'node_modules');
  const depsInstalled = existsSync(nodeModules);
  checks.push({
    name: 'dependencies installed',
    ok: depsInstalled,
    detail: depsInstalled ? nodeModules : 'node_modules missing',
    hint: depsInstalled ? undefined : `run: yarn --cwd ${root} install`,
  });
  const protocolDist = join(root, 'packages', 'protocol', 'dist', 'index.js');
  const harnessDist = join(root, 'packages', 'recipe-harness', 'dist', 'index.js');
  const built = existsSync(protocolDist) && existsSync(harnessDist);
  checks.push({
    name: 'workspace packages built',
    ok: built,
    detail: built ? 'protocol + recipe-harness dist present' : 'missing dist output',
    hint: built ? undefined : `run: yarn --cwd ${root} workspace @farmslot/recipe-harness build`,
  });
  if (depsInstalled) {
    const lock = join(root, 'yarn.lock');
    const stateFile = join(nodeModules, '.yarn-state.yml');
    const fresh =
      existsSync(lock) &&
      existsSync(stateFile) &&
      statSync(stateFile).mtimeMs >= statSync(lock).mtimeMs;
    // Recoverable advice, not breakage — stale deps warn instead of failing
    // an otherwise-successful command.
    checks.push({
      name: 'install fresh',
      ok: true,
      warn: !fresh,
      detail: fresh ? 'node_modules newer than yarn.lock' : 'yarn.lock changed since last install',
      hint: fresh ? undefined : 'run: farmslot update',
    });
  }
  // Follow symlink chains (bounded) — a single readlink misreports
  // link → link → workspace as "outside this workspace".
  const resolveLink = (p: string): string => {
    let current = p;
    for (let depth = 0; depth < 10 && lstatSync(current).isSymbolicLink(); depth++) {
      current = resolve(join(current, '..'), readlinkSync(current));
    }
    return current;
  };

  // This workspace's own install-time symlink (state.bin_dir/farmslot). A valid one
  // means the install succeeded even if a *different* farmslot is earlier on PATH.
  const installedLink = state?.bin_dir ? join(state.bin_dir, 'farmslot') : null;
  const ownLinkOk =
    installedLink !== null &&
    existsSync(installedLink) &&
    isInside(resolveLink(installedLink), root);

  const binPath = commandPath('farmslot');
  const binTarget = binPath ? resolveLink(binPath) : null;
  if (binPath && binTarget && isInside(binTarget, root)) {
    checks.push({ name: 'farmslot on PATH', ok: true, detail: binPath });
  } else if (ownLinkOk) {
    // The workspace symlink is valid; PATH either resolves to a different farmslot
    // first (custom BIN_DIR) or isn't updated yet. Warn with guidance — never fail,
    // so a custom install location cannot abort install.sh at the doctor gate.
    checks.push({
      name: 'farmslot on PATH',
      ok: true,
      warn: true,
      detail: binPath
        ? `${binPath} -> ${binTarget} (a different farmslot is first on PATH; this workspace: ${installedLink})`
        : `${installedLink} exists but ${state?.bin_dir} is not on PATH`,
      hint: `to use this workspace's CLI, put ${state?.bin_dir} ahead on your PATH: export PATH='${(state?.bin_dir ?? '').replace(/'/g, "'\\''")}':"$PATH"`,
    });
  } else {
    checks.push({
      name: 'farmslot on PATH',
      ok: false,
      detail: binPath ? `${binPath} -> ${binTarget} (outside this workspace)` : 'not found',
      hint: 're-run install.sh to create/repoint the symlink',
    });
  }
  return { title: 'CLI', checks };
}

function captureHelperSection(): DoctorSection {
  if (process.platform !== 'darwin') {
    return {
      title: 'Capture',
      checks: [
        {
          name: 'capture-helper',
          ok: true,
          warn: true,
          detail: 'skipped (macOS-only evidence helper)',
        },
      ],
    };
  }
  const bin = captureHelperPath();
  if (bin === 'capture-helper' && !commandPath('capture-helper')) {
    return {
      title: 'Capture',
      checks: [
        {
          name: 'capture-helper',
          ok: true,
          warn: true,
          detail: 'not found',
          hint: 'install: npm install -g @siteed/capture-helper (or the Homebrew formula)',
        },
      ],
    };
  }
  const result = spawnSync(bin, ['doctor', '--json'], { encoding: 'utf-8', timeout: 10_000 });
  if (result.status === 0) {
    return {
      title: 'Capture',
      checks: [{ name: 'capture-helper', ok: true, detail: `${bin} doctor passed` }],
    };
  }
  return {
    title: 'Capture',
    checks: [
      {
        name: 'capture-helper',
        ok: true,
        warn: true,
        detail: (result.stderr || result.stdout || result.error?.message || 'doctor failed').trim(),
        hint: 'run: capture-helper doctor --json; grant Screen Recording permission if requested',
      },
    ],
  };
}

/** Run git in `cwd`, returning trimmed stdout, or null on any non-zero exit. */
function gitOut(cwd: string, args: string[]): string | null {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

/**
 * Update freshness: is the clone behind origin's default branch? This is the
 * `farmslot update` signal (no semver stream — update = fetch + reset to origin).
 * Doctor does NOT fetch (kept fast and offline-safe); it compares against the
 * last-fetched remote-tracking ref. Behind is advice (WARN), never a failure —
 * the live Command Center banner does the network check.
 */
function updatesSection(ws: Workspace | null): DoctorSection {
  if (!ws) {
    return {
      title: 'Updates',
      checks: [{ name: 'up to date', ok: true, warn: true, detail: 'skipped (dev checkout mode)' }],
    };
  }
  const clone = ws.farmslotDir;
  if (gitOut(clone, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
    return {
      title: 'Updates',
      checks: [
        {
          name: 'up to date',
          ok: true,
          warn: true,
          detail: 'farmslot clone is not a git checkout',
          hint: 're-run install.sh',
        },
      ],
    };
  }
  const head = gitOut(clone, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  const branch = head ? head.replace(/^origin\//, '') : 'main';
  const remoteRef = `origin/${branch}`;
  if (gitOut(clone, ['rev-parse', '--verify', '--quiet', remoteRef]) === null) {
    return {
      title: 'Updates',
      checks: [
        {
          name: 'up to date',
          ok: true,
          warn: true,
          detail: `no ${remoteRef} tracking ref yet`,
          hint: 'run: farmslot update',
        },
      ],
    };
  }
  const behindRaw = gitOut(clone, ['rev-list', '--count', `HEAD..${remoteRef}`]);
  const behind = behindRaw ? Number.parseInt(behindRaw, 10) || 0 : 0;
  return {
    title: 'Updates',
    checks: [
      {
        name: 'up to date',
        ok: true,
        warn: behind > 0,
        detail:
          behind > 0
            ? `${behind} commit${behind === 1 ? '' : 's'} behind ${remoteRef} (as of last fetch)`
            : `up to date with ${remoteRef} (as of last fetch)`,
        hint: behind > 0 ? 'run: farmslot update' : undefined,
      },
    ],
  };
}

/**
 * Gateway profile health (ADR-036). A down remote gateway or a not-yet-logged-in
 * profile is advice (WARN), not a broken local install; only an unreadable
 * profile store fails the report.
 */
async function gatewaySection(): Promise<DoctorSection> {
  let profiles;
  try {
    profiles = loadProfiles();
  } catch (err) {
    return {
      title: 'Gateways',
      checks: [
        {
          name: 'profile store',
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
          hint: `fix or remove ${profilesPath()}`,
        },
      ],
    };
  }
  const names = Object.keys(profiles.gateways);
  if (names.length === 0) {
    return {
      title: 'Gateways',
      checks: [
        {
          name: 'profiles',
          ok: true,
          detail: 'none configured (ad-hoc --url mode) — farmslot gateway add <name> <ws-url>',
        },
      ],
    };
  }
  const checks = await Promise.all(
    names.map(async (name): Promise<DoctorCheck> => {
      const profile = profiles.gateways[name];
      const probe = await probeGatewayAuth(profile.url, profileCredential(profile));
      const label = profiles.active === name ? `${name} (active)` : name;
      switch (probe.state) {
        case 'authenticated':
          return {
            name: label,
            ok: true,
            detail: `authenticated (${probe.authMode}) ${profile.url}`,
          };
        case 'no-auth':
          return { name: label, ok: true, detail: `reachable, no auth required ${profile.url}` };
        case 'inactive':
          return {
            name: label,
            ok: true,
            warn: true,
            detail: `not signed in ${profile.url}`,
            hint: `run: farmslot login ${name}`,
          };
        case 'unreachable':
          return {
            name: label,
            ok: true,
            warn: true,
            detail: `unreachable ${profile.url}`,
            hint: 'check the gateway is running and the profile URL is correct',
          };
      }
    }),
  );
  return { title: 'Gateways', checks };
}

export async function runDoctor(ws: Workspace | null): Promise<DoctorReport> {
  const { section: workspace, state } = workspaceSection(ws);
  const sections = [
    prereqSection(),
    runnerSection(),
    workspace,
    poolSection(ws, state),
    packSection(ws, state),
    cliSection(ws, state),
    captureHelperSection(),
    updatesSection(ws),
    await gatewaySection(),
  ];
  return { sections, ok: sections.every((s) => s.checks.every((c) => c.ok)) };
}
