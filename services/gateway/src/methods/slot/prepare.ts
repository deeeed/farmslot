import { randomUUID } from 'node:crypto';
import { open as fsOpen, realpath, stat as fsStat } from 'node:fs/promises';
import path from 'node:path';

import { type FSWatcher, watch as chokidarWatch } from 'chokidar';

import {
  DEFAULT_BRANCH,
  type PreparePhase,
  SLOT_DESTRUCTIVE_OPS,
  type SlotPrepareParams,
} from '@farmslot/protocol';

import {
  applyProjectCommandEnv,
  execOnSlot,
  expandHook,
  expandTemplate,
  farmslotRoot,
  getProjectField,
  getProjectFieldRaw,
  isLocal,
  loadProjectVars,
  loadSlotVars,
  type ProjectVars,
  type RawProjectJson,
  slotFileExists,
  slotReadFile,
  slotWriteFile,
  slotWriteFiles,
  updateSlotStatus,
} from '../../core/index.js';
import { shellExpressionForRemotePath } from '../../core/remote-paths.js';
import { resolveTmuxSession, shellQuote, tmuxShellSnippet } from '../../core/tmux.js';
import { collectSupportFiles, supportHash } from '../../node-support/files.js';
import { resolveNodeSupportPaths } from '../../node-support/paths.js';
import {
  buildNodeSupportPublishCommand,
  buildNodeSupportVerifyCommand,
} from '../../node-support/publish-command.js';
import { assertStartRefWorkBranchIsLocalOnly } from '../../projects/start-ref-policy.js';
import {
  resolveStartRefInRepo,
  type StartRefResolution,
} from '../../projects/start-ref-resolution.js';
import { executeEvalHarnessLifecycle } from '../../run-engine/eval-harness-lifecycle.js';
import { getRun } from '../../runs/store.js';

import { runHealthCheck } from './check.js';
import { runFixtureSync } from './fixtures.js';
import {
  CLEAR_INDEX_FLAGS_COMMAND,
  CLEAR_INDEX_FLAGS_THEN_REFRESH_COMMAND,
  REFRESH_INDEX_AND_UNLOCK_COMMAND,
} from './git-cleanup-commands.js';
import { bindRunToSlot } from './prepare-bind.js';
import {
  buildDevServerPortCleanup,
  clearStalePrepareProcess,
  PREPARE_DEPS_TIMEOUT_MS,
  PREPARE_PREFLIGHT_TIMEOUT_MS,
  runPrepareCommand,
} from './prepare-command.js';
import {
  buildDepsSentinelWriteCommand,
  checkPrepareRequirement,
  type ResolvedPrepareProfile,
  selectPrepareProfile,
} from './prepare-profile.js';
import {
  acquirePrepareSentinel,
  type PrepareSentinelLock,
  releasePrepareSentinel,
  startPrepareSentinelHeartbeat,
} from './prepare-sentinel.js';
import { createPrepareStream, type PrepareStream } from './prepare-stream.js';
import {
  activePrepareSessions,
  activePrepareSlots,
  applySelectedApp,
  type EventEmitter,
  type PrepareCommandError,
  sanitizePhaseName,
  type SlotPrepareInternalOptions,
  type SlotPrepareResult,
} from './shared.js';
import {
  assertSlotNotOperatorRoot,
  detectLinkedWorktree,
  isSlotIdleBranch,
  remoteBranchRefspec,
  resolvePrepareMergeMainStrategy,
  resolveSlotTrackingBranchFromProject,
  shouldSoftFailPrepareIntegration,
  worktreeBaseResetRef,
} from './slot-tracking.js';

export { isLinkedGitWorktreeMarker, worktreeBaseResetRef } from './slot-tracking.js';

export async function slotPrepare(
  params: SlotPrepareParams,
  emit: EventEmitter,
  signal?: AbortSignal,
  opts?: SlotPrepareInternalOptions,
): Promise<SlotPrepareResult> {
  if (activePrepareSlots.has(params.slotId)) {
    throw new Error(`Slot ${params.slotId} is already preparing`);
  }
  activePrepareSlots.add(params.slotId);
  const requestId = params.requestId ?? `prepare-${randomUUID()}`;
  const stream = createPrepareStream(emit, {
    slotId: params.slotId,
    requestId,
    startTime: Date.now(),
  });
  let prepareError: unknown;
  let sentinel: PrepareSentinelLock | null = null;
  try {
    const vars = await loadSlotVars(params.slotId);
    // Prepare runs `git reset --hard origin/<branch>` + `git clean -fd` on the
    // slot repo — never against the gateway's own operator root.
    await assertSlotNotOperatorRoot(vars, SLOT_DESTRUCTIVE_OPS.prepare);
    sentinel = await acquirePrepareSentinel(vars, params);
    if (sentinel) startPrepareSentinelHeartbeat(sentinel);
    const result = await slotPrepareInner(params, stream, signal, opts);
    if (!result.prepared) {
      stream.complete(1, `Slot ${params.slotId} is disabled`);
    } else {
      stream.complete(0);
    }
    return { ...result, requestId };
  } catch (error) {
    prepareError = error;
    stream.complete(1, (error as Error).message);
    throw error;
  } finally {
    try {
      if (sentinel) await releasePrepareSentinel(sentinel, prepareError);
    } finally {
      activePrepareSlots.delete(params.slotId);
      // Belt-and-suspenders: stream.complete() already clears this, but guard
      // against any path that throws before complete() runs so the reattach
      // buffer can't go stale.
      activePrepareSessions.delete(params.slotId);
    }
  }
}

export async function readPrepareLogTailChunk(
  logFilePath: string,
  offset: number,
): Promise<{ offset: number; output: string }> {
  const fh = await fsOpen(logFilePath, 'r');
  try {
    const st = await fh.stat();
    const start = st.size < offset ? 0 : offset;
    if (st.size <= start) {
      return { offset: start, output: '' };
    }
    const buf = Buffer.alloc(st.size - start);
    await fh.read(buf, 0, buf.length, start);
    return { offset: st.size, output: buf.toString('utf-8') };
  } finally {
    await fh.close();
  }
}

async function slotPrepareInner(
  params: SlotPrepareParams,
  stream: PrepareStream,
  signal?: AbortSignal,
  opts?: SlotPrepareInternalOptions,
): Promise<Omit<SlotPrepareResult, 'requestId'>> {
  const vars = await loadSlotVars(params.slotId);
  const selectedApp = await applySelectedApp(vars, params.app);
  const checkAborted = () => {
    if (signal?.aborted) throw new Error('Prepare cancelled');
  };
  if (!vars.slotEnabled) {
    stream.step('skip', `Slot ${params.slotId} is disabled`);
    return { prepared: false };
  }

  let projectVars: ProjectVars | undefined;
  let projectJson: RawProjectJson = {};
  try {
    projectVars = await loadProjectVars(vars.projectName);
    projectJson = projectVars.projectJson;
  } catch {
    /* no project config */
  }

  const defaultBranch = getProjectField(projectJson, 'default_branch') || DEFAULT_BRANCH;
  const devServerName = getProjectField(projectJson, 'health.dev_server_name') || 'DevServer';
  const readyIndicator = getProjectField(projectJson, 'health.ready_indicator');
  const projectTimeoutMs = (field: string, fallbackMs: number): number => {
    const raw = getProjectFieldRaw(projectJson, field);
    const seconds = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : fallbackMs;
  };
  const depsTimeoutMs = projectTimeoutMs('timeouts.prepare_deps_s', PREPARE_DEPS_TIMEOUT_MS);
  const preflightTimeoutMs = projectTimeoutMs(
    'timeouts.prepare_preflight_s',
    PREPARE_PREFLIGHT_TIMEOUT_MS,
  );
  const branch = params.branch || '';
  if (opts?.startRef && !branch) {
    throw new Error('startRef prepare requires a work branch');
  }

  if (params.bindRunId && params.bindOnly) {
    stream.step('bind-only', 'Branch already matches — skipping prepare phases');
    await bindRunToSlot(params, vars, stream.step.bind(stream));
    if (branch) {
      await updateSlotStatus(params.slotId, { branch });
    }
    return {
      prepared: true,
      profile: {
        selected: 'bind-only',
        ...(params.prepareProfile ? { requested: params.prepareProfile } : {}),
        fallbacks: [],
      },
    };
  }
  // Tmux prepare window label — short run id when present so the window name
  // (e.g. `prepare-3308c99d-deps`, `prepare-3308c99d-preflight`) maps directly
  // to the run-detail page. Falls back to a timestamp for manual `cdp.mjs
  // gateway slot.prepare` invocations that aren't tied to a run.
  const windowLabel = params.runId ? params.runId.slice(0, 8) : undefined;
  const mergeMain = params.mergeMain ?? false;
  const forceNewBranch = params.forceNewBranch ?? false;
  let resolvedStartRef: StartRefResolution | undefined;
  const runtimeDir = projectVars?.runtimeDir || '.agent';
  const applyCommandEnv = (command: string) => applyProjectCommandEnv(projectJson, command);
  const slotIsLocal = isLocal(vars.host, vars.machine);
  const prepareLogDir = slotIsLocal
    ? path.join(vars.remoteRepo, runtimeDir, 'prepare-logs')
    : path.join(farmslotRoot, '.omx', 'logs', `prepare-${params.slotId}`);
  const phaseLog = (name: string) => path.join(prepareLogDir, `${sanitizePhaseName(name)}.log`);

  const step = stream.step.bind(stream);

  let hookSupportDir: string | undefined;
  let hookSupportChecked = false;
  const hookSupportManifestPath = () => path.posix.join(hookSupportDir!, 'manifest.json');
  const pathWithin = (rootPath: string, candidatePath: string): boolean => {
    const relative = path.relative(rootPath, candidatePath);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };

  const materializeHookSupport = async () => {
    if (!projectVars || hookSupportChecked) return;
    hookSupportChecked = true;
    const { paths: supportPaths } = resolveNodeSupportPaths(
      vars.projectName,
      projectJson,
      farmslotRoot,
    );
    if (supportPaths.length === 0) return;
    if (slotIsLocal) {
      hookSupportDir = farmslotRoot;
      step('support', 'Using local node support source');
      return;
    }
    const farmslotRootRealPath = await realpath(farmslotRoot);
    const files = (
      await Promise.all(
        supportPaths.map(async (supportPath) => {
          const sourcePath = path.join(farmslotRoot, supportPath);
          const sourceRealPath = await realpath(sourcePath);
          if (!pathWithin(farmslotRootRealPath, sourceRealPath)) {
            throw new Error(`Node support path escapes Farmslot root: ${supportPath}`);
          }
          return collectSupportFiles(sourcePath, supportPath);
        }),
      )
    ).flat();
    const manifest = {
      version: 1,
      project: vars.projectName,
      hash: supportHash(files),
      paths: supportPaths,
      fileCount: files.length,
      files: files.map((file) => ({
        path: file.relativePath,
        sha256: file.sha256,
        mode: file.mode.toString(8).padStart(3, '0'),
        size: file.size,
      })),
    };

    hookSupportDir = path.posix.join('~/farmslot-node/support', manifest.hash);
    const verifyHookSupport = async () => {
      const verifyResult = await execOnSlot(
        vars,
        buildNodeSupportVerifyCommand({
          manifestPath: hookSupportManifestPath(),
          supportDir: hookSupportDir!,
          files,
        }),
      );
      return verifyResult.exitCode === 0;
    };
    if (await slotFileExists(vars, hookSupportManifestPath())) {
      const current = JSON.parse(await slotReadFile(vars, hookSupportManifestPath())) as {
        hash?: string;
      };
      if (current.hash === manifest.hash) {
        if (!(await verifyHookSupport())) {
          throw new Error(`Node support bundle corrupt for ${manifest.hash}`);
        }
        step('support', `Node support bundle current (${files.length} files)`);
        return;
      }
    }

    const incomingResult = await execOnSlot(
      vars,
      [
        `mkdir -p ${shellExpressionForRemotePath('~/farmslot-node/support/.incoming')}`,
        `mktemp -d ${shellExpressionForRemotePath(
          path.posix.join('~/farmslot-node/support/.incoming', `${manifest.hash}.XXXXXX`),
        )}`,
      ].join(' && '),
    );
    if (incomingResult.exitCode !== 0) {
      throw new Error(`Node support temp dir creation failed: ${incomingResult.stderr}`);
    }
    const incomingDir = incomingResult.stdout.trim().split(/\r?\n/).at(-1);
    if (!incomingDir) throw new Error('Node support temp dir creation produced no path');

    // Materialize the whole bundle in one RPC (parent dirs + modes included)
    // rather than a mkdir/write/chmod round-trip per file. A throw here — before
    // the verify/publish branches, which already clean up — would otherwise
    // orphan the mktemp'd incoming dir, so cover the upload + manifest write.
    try {
      await slotWriteFiles(
        vars,
        incomingDir,
        files.map((file) => ({
          path: file.relativePath,
          content: file.contentBase64,
          mode: file.mode,
        })),
      );
      await slotWriteFile(
        vars,
        path.posix.join(incomingDir, 'manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
    } catch (error) {
      // execOnSlot reports failure via exitCode rather than throwing, so this
      // best-effort cleanup won't mask the original error before we rethrow it.
      await execOnSlot(vars, `rm -rf ${shellExpressionForRemotePath(incomingDir)}`);
      throw error;
    }
    const incomingVerifyResult = await execOnSlot(
      vars,
      buildNodeSupportVerifyCommand({
        manifestPath: path.posix.join(incomingDir, 'manifest.json'),
        supportDir: incomingDir,
        files,
      }),
    );
    if (incomingVerifyResult.exitCode !== 0) {
      await execOnSlot(vars, `rm -rf ${shellExpressionForRemotePath(incomingDir)}`);
      throw new Error(`Node support incoming verification failed for ${manifest.hash}`);
    }
    const publishResult = await execOnSlot(
      vars,
      buildNodeSupportPublishCommand({
        incomingDir,
        manifestPath: hookSupportManifestPath(),
        supportDir: hookSupportDir,
        supportHash: manifest.hash,
      }),
    );
    if (publishResult.exitCode !== 0) {
      const cleanupResult = await execOnSlot(
        vars,
        `rm -rf ${shellExpressionForRemotePath(incomingDir)}`,
      );
      const cleanupDetail =
        cleanupResult.exitCode === 0 ? '' : `; cleanup failed: ${cleanupResult.stderr}`;
      throw new Error(`Node support publish failed: ${publishResult.stderr}${cleanupDetail}`);
    }
    const published = JSON.parse(await slotReadFile(vars, hookSupportManifestPath())) as {
      hash?: string;
    };
    if (published.hash !== manifest.hash) {
      throw new Error(`Node support publish hash mismatch for ${manifest.hash}`);
    }
    if (!(await verifyHookSupport())) {
      throw new Error(`Node support publish verification failed for ${manifest.hash}`);
    }
    step(
      'support',
      `Synced node support bundle (${files.length} files: ${supportPaths.join(', ')})`,
    );
  };

  const remapHookSupport = (command: string): string => {
    if (!hookSupportDir || !command) return command;
    return command
      .replaceAll('{{node_support_dir}}', hookSupportDir)
      .replaceAll('{{NODE_SUPPORT_DIR}}', hookSupportDir)
      .replaceAll(`${farmslotRoot}/projects/`, `${hookSupportDir}/projects/`)
      .replaceAll(`${farmslotRoot}/scripts/`, `${hookSupportDir}/scripts/`)
      .replaceAll('~/farmslot-node/projects/', `${hookSupportDir}/projects/`)
      .replaceAll('~/farmslot-node/scripts/', `${hookSupportDir}/scripts/`);
  };

  // Selected prepare profile (ADR-037). Assigned right after the SSH check;
  // undefined only for steps that run before selection, none of which are
  // phase-gated or hook-expanding.
  let prepareProfile: ResolvedPrepareProfile | undefined;
  const profileName = (): string => prepareProfile?.name ?? 'full';
  const phaseEnabled = (phase: PreparePhase): boolean =>
    !prepareProfile || prepareProfile.phases.has(phase);
  // Every hook a prepare runs sees the selected profile, so a single project
  // script can branch on FARMSLOT_PREPARE_PROFILE instead of per-profile hooks.
  // Subshell form keeps the wrapper safe inside `a && b` chains.
  const withProfileEnv = (cmd: string): string =>
    `( export FARMSLOT_PREPARE_PROFILE=${shellQuote(profileName())}; ${cmd} )`;

  const expandPrepareHook = (hookName: string): string => {
    const override = prepareProfile?.hooks[hookName];
    const cmd = override
      ? expandTemplate(override, vars, projectVars)
      : expandHook(hookName, projectJson, vars, projectVars);
    return remapHookSupport(cmd);
  };

  const installEvalRecipeHarness = async () => {
    if (!params.runId) return;
    const run = getRun(params.runId);
    if (!run?.engineState?.evalExperiment) return;
    step('recipe-harness-install', 'Installing eval recipe harness');
    const result = await executeEvalHarnessLifecycle(run, 'install');
    if (!result.skipped) {
      step('recipe-harness-install', `Eval recipe harness installed (log: ${result.logPath})`);
    }
  };

  if (selectedApp) {
    await updateSlotStatus(params.slotId, { app: selectedApp });
    step('app', `Selected app ${selectedApp}`);
  }

  // 1. Connection check — local slots skip SSH entirely
  if (isLocal(vars.host, vars.machine)) {
    step('connect', `Local slot on ${vars.machine}`);
  } else {
    step('ssh', `Checking ${vars.sshTarget}...`);
    const r = await execOnSlot(vars, 'echo ok');
    if (r.exitCode !== 0) throw new Error(`Cannot reach ${vars.sshTarget}`);
    step('ssh', `Connected to ${vars.sshTarget}`);
  }
  await materializeHookSupport();

  // 1b. Resolve prepare profile (ADR-037): explicit request → prepare.default →
  // implicit full. Precondition failures walk the project's declared fallback
  // chain; every check and transition is logged as a prepare sub-step.
  const profileSelection = await selectPrepareProfile(
    { vars, projectJson, projectVars, runtimeDir },
    params.prepareProfile,
    (candidate, result) =>
      step(
        'profile',
        `[${candidate}] ${result.requirement} ${result.ok ? 'ok' : 'fail'} — ${result.detail}`,
      ),
    checkPrepareRequirement,
    { strict: params.strictProfile === true },
  );
  for (const fb of profileSelection.fallbacks) {
    step(
      'profile',
      `Profile '${fb.from}' preconditions failed (${fb.reason}); falling back to '${fb.to}'`,
    );
  }
  prepareProfile = profileSelection.profile;
  if (!phaseEnabled('git') && (branch || mergeMain)) {
    // Branch targeting and mergeMain are run-level (flow-driven) parameters; a
    // profile that omits git must not silently prepare the wrong ref.
    prepareProfile.phases.add('git');
    step(
      'profile',
      `git phase forced on: run supplies ${branch ? `branch ${branch}` : 'mergeMain'}`,
    );
  }
  step(
    'profile',
    `Prepare profile '${prepareProfile.name}' — phases: ${[...prepareProfile.phases].join(', ')}`,
  );

  // 1c. Device existence check (fail fast)
  const iosSim = vars.resourceVars.simulator ?? '';
  const androidAvd = vars.resourceVars.avd ?? '';
  if (vars.platform === 'ios' && iosSim) {
    step('device', `Checking simulator ${iosSim}...`);
    const findSimulatorScript = [
      'import json,sys',
      'name=sys.argv[1]',
      'data=json.load(sys.stdin)',
      "for rt,devs in data.get('devices',{}).items():",
      '  for d in devs:',
      "    if d.get('name') == name: print(d.get('udid','')); sys.exit(0)",
    ].join('\n');
    const r = await execOnSlot(
      vars,
      `xcrun simctl list devices -j 2>/dev/null | python3 -c ${shellQuote(findSimulatorScript)} ${shellQuote(iosSim)}`,
    );
    if (!r.stdout.trim()) throw new Error(`Simulator '${iosSim}' not found`);
    step('device', `Simulator ${iosSim} found`);
  } else if (vars.platform === 'android' && androidAvd) {
    step('device', `Checking AVD ${androidAvd}...`);
    const r = await execOnSlot(
      vars,
      `\${ANDROID_HOME:-\$HOME/Android/Sdk}/cmdline-tools/latest/bin/avdmanager list avd -c 2>/dev/null | grep -Fx -- ${shellQuote(androidAvd)}`,
    );
    if (!r.stdout.trim()) throw new Error(`AVD '${androidAvd}' not found`);
    step('device', `AVD ${androidAvd} found`);
  }

  let fixturesSynced = false;
  // Fixtures are framework file materialization (template render + copy), not a
  // project hook invocation, so they intentionally do not receive
  // FARMSLOT_PREPARE_PROFILE — ADR-037's "every hook" covers deps/preflight/
  // health/unlock, which run project-owned commands.
  const syncFixtures = async () => {
    if (fixturesSynced) return;
    if (!phaseEnabled('fixtures')) {
      step('fixtures', `Fixtures sync skipped (profile ${profileName()})`);
      fixturesSynced = true;
      return;
    }
    checkAborted();
    step('fixtures', 'Syncing fixtures...');
    const syncLogPath = phaseLog('fixtures');
    await runFixtureSync(vars, {
      slotId: params.slotId,
      flowType: params.flowType,
      domain: params.domain ?? vars.domain,
      selectedApp,
      logPath: syncLogPath,
      signal,
      windowLabel,
      phase: 'fixtures',
    });
    step('fixtures', `Fixtures synced (log: ${syncLogPath})`);
    fixturesSynced = true;
  };

  // 2. Verify clean state / checkout branch
  const current = (
    await execOnSlot(
      vars,
      `git -C ${shellQuote(vars.remoteRepo)} rev-parse --abbrev-ref HEAD 2>/dev/null`,
    )
  ).stdout.trim();

  if (!phaseEnabled('git')) {
    // Profiles without the git phase reuse the slot's current checkout. Branch
    // and mergeMain runs can never reach here — selection forces git on for them.
    step(
      'branch',
      `git sync skipped (profile ${profileName()}; HEAD stays on '${current || 'unknown'}')`,
    );
  } else {
    if (!branch && current && current !== defaultBranch) {
      const linkedWorktree = await detectLinkedWorktree(vars);
      const trackingBranch = resolveSlotTrackingBranchFromProject(
        projectJson,
        vars,
        projectVars,
        linkedWorktree,
      );
      if (!isSlotIdleBranch(current, trackingBranch, defaultBranch, linkedWorktree)) {
        const expected = linkedWorktree
          ? `'${trackingBranch}' or '${defaultBranch}'`
          : `'${defaultBranch}'`;
        throw new Error(
          `Slot is on '${current}', expected ${expected}. Run release-slot.sh first.`,
        );
      }
      const fetchDefaultR = await execOnSlot(
        vars,
        `cd ${shellQuote(vars.remoteRepo)} && git fetch origin ${shellQuote(remoteBranchRefspec(defaultBranch))}`,
      );
      if (fetchDefaultR.exitCode !== 0) {
        throw new Error(
          `git fetch origin ${defaultBranch} failed on ${vars.slotId} (${vars.remoteRepo}): ${fetchDefaultR.stderr.slice(-200) || fetchDefaultR.stdout.slice(-200)}`,
        );
      }
      const headR = await execOnSlot(
        vars,
        `cd ${shellQuote(vars.remoteRepo)} && git rev-parse HEAD ${shellQuote(`origin/${defaultBranch}`)} 2>/dev/null`,
      );
      const refs = headR.stdout.trim().split(/\s+/).filter(Boolean);
      const worktreeAtDefault = headR.exitCode === 0 && refs.length === 2 && refs[0] === refs[1];
      if (!worktreeAtDefault) {
        throw new Error(
          `Slot is on '${current}', expected '${trackingBranch}' @ origin/${defaultBranch}. Run release-slot.sh first.`,
        );
      }
      step(
        'branch',
        linkedWorktree
          ? `Worktree tracking branch '${current}' matches origin/${defaultBranch}; proceeding`
          : `HEAD matches origin/${defaultBranch}; proceeding`,
      );
    }

    // 2b. Force local view of origin/HEAD to defaultBranch.
    // `gh pr create` defaults to refs/remotes/origin/HEAD when --base is omitted, so a drifted
    // symbolic ref silently produces wrong-base PRs. Reset it every prepare and hard-fail if
    // it still doesn't match — this is the single gate per CLAUDE.md.
    step('origin-head', `Resetting origin/HEAD to ${defaultBranch}...`);
    await execOnSlot(
      vars,
      `cd ${shellQuote(vars.remoteRepo)} && git remote set-head origin ${shellQuote(defaultBranch)} 2>/dev/null`,
    );
    const originHead = (
      await execOnSlot(
        vars,
        `cd ${shellQuote(vars.remoteRepo)} && git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null`,
      )
    ).stdout.trim();
    const expectedHead = `refs/remotes/origin/${defaultBranch}`;
    if (originHead !== expectedHead) {
      throw new Error(
        `origin/HEAD is '${originHead || 'unset'}' (expected '${expectedHead}'). Refusing to dispatch — gh pr create would default to the wrong base.`,
      );
    }
    step('origin-head', `origin/HEAD = ${expectedHead}`);
  }

  if (branch) {
    step('branch', `Checking out ${branch}...`);
    if (current === branch && !forceNewBranch) {
      const fetchBranchR = await execOnSlot(
        vars,
        `cd ${shellQuote(vars.remoteRepo)} && git fetch origin ${shellQuote(remoteBranchRefspec(branch))}`,
      );
      if (fetchBranchR.exitCode === 0) {
        const refreshCurrentBranchR = await execOnSlot(
          vars,
          `cd ${shellQuote(vars.remoteRepo)} && { ${CLEAR_INDEX_FLAGS_THEN_REFRESH_COMMAND}; }`,
        );
        if (refreshCurrentBranchR.exitCode !== 0) {
          throw new Error(
            `failed to clear skip-worktree/assume-unchanged flags on ${vars.slotId} (${vars.remoteRepo}): ${refreshCurrentBranchR.stderr.slice(-200) || refreshCurrentBranchR.stdout.slice(-200)}`,
          );
        }
        const resetBranchR = await execOnSlot(
          vars,
          `cd ${shellQuote(vars.remoteRepo)} && git reset --hard ${shellQuote(`origin/${branch}`)} && git clean -fd`,
        );
        if (resetBranchR.exitCode !== 0) {
          throw new Error(
            `Branch refresh failed: ${resetBranchR.stderr.slice(-200) || resetBranchR.stdout.slice(-200)}`,
          );
        }
        const dirty = (
          await execOnSlot(vars, `cd ${shellQuote(vars.remoteRepo)} && git status --porcelain`)
        ).stdout.trim();
        if (dirty) {
          throw new Error(
            `Working tree still dirty on ${vars.slotId} after reset to origin/${branch}. Refusing to prepare stale/dirty slot. Inspect with: cd ${shellQuote(vars.remoteRepo)} && git status\nDirty paths:\n${dirty}`,
          );
        }
        step('branch', `Already on ${branch}; reset to origin/${branch}`);
      } else {
        const fetchErr = `${fetchBranchR.stderr}\n${fetchBranchR.stdout}`;
        if (!/couldn't find remote ref|could not find remote ref|no such ref/i.test(fetchErr)) {
          throw new Error(
            `git fetch origin ${branch} failed on ${vars.slotId} (${vars.remoteRepo}): ${fetchBranchR.stderr.slice(-200) || fetchBranchR.stdout.slice(-200)}`,
          );
        }
        step('branch', `Remote branch ${branch} not found; using existing local ${branch}`);
      }
    } else {
      const fetchDefaultR = await execOnSlot(
        vars,
        `cd ${shellQuote(vars.remoteRepo)} && git fetch origin ${shellQuote(remoteBranchRefspec(defaultBranch))}`,
      );
      if (fetchDefaultR.exitCode !== 0)
        throw new Error(
          `git fetch origin ${defaultBranch} failed on ${vars.slotId} (${vars.remoteRepo}): ${fetchDefaultR.stderr.slice(-200) || fetchDefaultR.stdout.slice(-200)}`,
        );
      if (opts?.startRef) {
        step('start-ref', `Resolving base ref ${opts.startRef.requestedRef}...`);
        resolvedStartRef = await resolveStartRefInRepo({
          repo: vars.remoteRepo,
          requestedRef: opts.startRef.requestedRef,
          exec: (command) => execOnSlot(vars, command),
        });
        step(
          'start-ref',
          `Base ref ${resolvedStartRef.requestedRef} resolved to ${resolvedStartRef.resolvedSha}`,
        );
      }
      const fetchBranchR = await execOnSlot(
        vars,
        `cd ${shellQuote(vars.remoteRepo)} && git fetch origin ${shellQuote(remoteBranchRefspec(branch))}`,
      );
      if (fetchBranchR.exitCode !== 0) {
        const fetchErr = `${fetchBranchR.stderr}\n${fetchBranchR.stdout}`;
        if (!/couldn't find remote ref|could not find remote ref|no such ref/i.test(fetchErr)) {
          throw new Error(
            `git fetch origin ${branch} failed on ${vars.slotId} (${vars.remoteRepo}): ${fetchBranchR.stderr.slice(-200) || fetchBranchR.stdout.slice(-200)}`,
          );
        }
        step('branch', `Remote branch ${branch} not found; will create locally if needed`);
      }
      // Clear any skip-worktree / assume-unchanged flags inherited from a prior
      // fixture run. Legacy sync-fixtures.sh used `--skip-worktree` to hide
      // fixture-written tracked files from `git status`; the flag persisted
      // across runs and permanently broke `git reset --hard <ref>` ("Entry not
      // uptodate. Cannot merge."). Sweep here so the cleanup chain below is
      // guaranteed effective regardless of slot history. `git ls-files -v`
      // prefixes flagged entries with a single letter — uppercase `S` for
      // skip-worktree, lowercase `h`/`s`/`m`/`r`/`c`/`k` for assume-unchanged
      // variants. We pre-collect paths in shell so the empty case (no flags)
      // skips the update loop entirely, and each path is read line-by-line so
      // tracked paths containing spaces are preserved.
      // Two passes are required: `git update-index --no-skip-worktree
      // --no-assume-unchanged` exits 0 but only applies the last flag (git's
      // argument parsing keeps the final mutation), so combining them silently
      // leaves skip-worktree intact and the next `reset --hard <ref>` trips on
      // "Entry not uptodate. Cannot merge." Run them as separate invocations.
      const flagSweep = await execOnSlot(
        vars,
        `cd ${shellQuote(vars.remoteRepo)} && { ${CLEAR_INDEX_FLAGS_COMMAND}; }`,
      );
      if (flagSweep.exitCode !== 0)
        throw new Error(
          `failed to clear skip-worktree/assume-unchanged flags on ${vars.slotId} (${vars.remoteRepo}): ${flagSweep.stderr.slice(-200) || flagSweep.stdout.slice(-200)}`,
        );
      // Force a clean tree at origin/<defaultBranch> so subsequent checkouts can never
      // be blocked by tracked-file modifications left over from a prior worker or
      // fixture write. Each step runs separately with exitCode checks so a failure
      // (e.g. defaultBranch missing locally on a fresh clone) surfaces immediately
      // instead of being masked by `;` chaining and a wrong-base downstream checkout.
      // Note: `git clean -fd` deliberately preserves ignored files (node_modules etc.).
      // If a future fixture writes to a gitignored path that conflicts with a tracked
      // file in the target branch, this still fails — handled by the porcelain check.
      //
      // `git update-index --refresh -q` is run before every `reset --hard <ref>` to
      // flush stale stat-cache entries left by `flagSweep` above (which clears
      // skip-worktree / assume-unchanged) AND by `syncFixtures` overwriting tracked
      // files listed in `.git/info/exclude` (e.g. AGENTS.md). Without the refresh,
      // git refuses with "Entry 'AGENTS.md' not uptodate. Cannot merge." Exit
      // non-zero when files differ is expected and ignored (`|| true`); the reset
      // itself does the actual normalization once `flagSweep` actually clears
      // skip-worktree (see the two-pass note above).
      // Same prefix detects + clears a stale `.git/index.lock` left by a crashed
      // prior git invocation — without this, every retry within ~5min hits
      // "Could not reset index file" until the lock ages out.
      const resetR = await execOnSlot(
        vars,
        `cd ${shellQuote(vars.remoteRepo)} && { ${REFRESH_INDEX_AND_UNLOCK_COMMAND}; git reset --hard HEAD; }`,
      );
      if (resetR.exitCode !== 0)
        throw new Error(
          `reset --hard HEAD failed on ${vars.slotId} (${vars.remoteRepo}): ${resetR.stderr.slice(-200) || resetR.stdout.slice(-200)}`,
        );
      const cleanR = await execOnSlot(vars, `cd ${shellQuote(vars.remoteRepo)} && git clean -fd`);
      if (cleanR.exitCode !== 0)
        throw new Error(
          `git clean -fd failed on ${vars.slotId} (${vars.remoteRepo}): ${cleanR.stderr.slice(-200) || cleanR.stdout.slice(-200)}`,
        );
      const linkedWorktree = await detectLinkedWorktree(vars);
      const baseResetRef = worktreeBaseResetRef(defaultBranch, resolvedStartRef ?? null);
      if (linkedWorktree) {
        // Git worktrees cannot checkout `main` when it is active in the primary clone.
        // Reset the current worktree branch directly to the resolved base commit instead.
        const ffR = await execOnSlot(
          vars,
          `cd ${shellQuote(vars.remoteRepo)} && { ${REFRESH_INDEX_AND_UNLOCK_COMMAND}; git reset --hard ${shellQuote(baseResetRef)}; }`,
        );
        if (ffR.exitCode !== 0)
          throw new Error(
            `worktree reset to ${baseResetRef} failed on ${vars.slotId} (${vars.remoteRepo}): ${ffR.stderr.slice(-200) || ffR.stdout.slice(-200)}`,
          );
        const dirty = (
          await execOnSlot(vars, `cd ${shellQuote(vars.remoteRepo)} && git status --porcelain`)
        ).stdout.trim();
        if (dirty) {
          throw new Error(
            `Working tree still dirty on ${vars.slotId} after worktree reset to ${baseResetRef}. Refusing to checkout ${branch}. Inspect with: cd ${shellQuote(vars.remoteRepo)} && git status\nDirty paths:\n${dirty}`,
          );
        }
        step('branch', `Worktree synced to ${baseResetRef} without checking out ${defaultBranch}`);
      } else {
        const coDefaultR = await execOnSlot(
          vars,
          `cd ${shellQuote(vars.remoteRepo)} && git checkout ${defaultBranch}`,
        );
        if (coDefaultR.exitCode !== 0)
          throw new Error(
            `checkout ${defaultBranch} failed on ${vars.slotId} (${vars.remoteRepo}): ${coDefaultR.stderr.slice(-200) || coDefaultR.stdout.slice(-200)}`,
          );
        const ffR = await execOnSlot(
          vars,
          `cd ${shellQuote(vars.remoteRepo)} && { ${REFRESH_INDEX_AND_UNLOCK_COMMAND}; git reset --hard origin/${defaultBranch}; }`,
        );
        if (ffR.exitCode !== 0)
          throw new Error(
            `fast-forward to origin/${defaultBranch} failed on ${vars.slotId} (${vars.remoteRepo}): ${ffR.stderr.slice(-200) || ffR.stdout.slice(-200)}`,
          );
        const dirty = (
          await execOnSlot(vars, `cd ${shellQuote(vars.remoteRepo)} && git status --porcelain`)
        ).stdout.trim();
        if (dirty) {
          throw new Error(
            `Working tree still dirty on ${vars.slotId} after reset to origin/${defaultBranch}. Refusing to checkout ${branch}. Inspect with: cd ${shellQuote(vars.remoteRepo)} && git status\nDirty paths:\n${dirty}`,
          );
        }
        step(
          'branch',
          `Local ${defaultBranch} fast-forwarded to origin/${defaultBranch} (clean tree)`,
        );
      }
      // Check if branch exists on remote
      const remoteExists =
        (
          await execOnSlot(
            vars,
            `cd ${shellQuote(vars.remoteRepo)} && git ls-remote --exit-code origin refs/heads/${shellQuote(branch)} >/dev/null 2>&1`,
          )
        ).exitCode === 0;
      const newBranchBase = resolvedStartRef?.resolvedSha ?? `origin/${defaultBranch}`;
      const newBranchBaseLabel = resolvedStartRef
        ? resolvedStartRef.resolvedSha
        : `origin/${defaultBranch}`;
      assertStartRefWorkBranchIsLocalOnly({ branch, remoteExists, startRef: resolvedStartRef });

      if (forceNewBranch && remoteExists) {
        // New work flow (fix-bug/dev): delete stale remote branch and recreate from defaultBranch
        step('branch', `Deleting stale remote ${branch} (forceNewBranch)...`);
        if (!linkedWorktree) {
          await execOnSlot(
            vars,
            `cd ${shellQuote(vars.remoteRepo)} && git checkout ${defaultBranch} 2>/dev/null`,
          );
        }
        await execOnSlot(
          vars,
          `cd ${shellQuote(vars.remoteRepo)} && git branch -D ${shellQuote(branch)} 2>/dev/null`,
        );
        await execOnSlot(
          vars,
          `cd ${shellQuote(vars.remoteRepo)} && git push origin --delete ${shellQuote(branch)} 2>/dev/null`,
        );
        await execOnSlot(
          vars,
          `cd ${shellQuote(vars.remoteRepo)} && git checkout -b ${shellQuote(branch)} ${shellQuote(newBranchBase)}`,
        );
        step('branch', `Recreated ${branch} from ${newBranchBaseLabel}`);
      } else if (remoteExists) {
        const localExists =
          (
            await execOnSlot(
              vars,
              `cd ${shellQuote(vars.remoteRepo)} && git rev-parse --verify ${shellQuote(branch)} >/dev/null 2>&1`,
            )
          ).exitCode === 0;
        if (localExists) {
          const coR = await execOnSlot(
            vars,
            `cd ${shellQuote(vars.remoteRepo)} && git checkout ${shellQuote(branch)} && git reset --hard ${shellQuote(`origin/${branch}`)}`,
          );
          if (coR.exitCode !== 0)
            throw new Error(
              `Branch checkout failed: ${coR.stderr.slice(-200) || coR.stdout.slice(-200)}`,
            );
          step('branch', `Switched to ${branch} (reset to origin/${branch})`);
        } else {
          const coR = await execOnSlot(
            vars,
            `cd ${shellQuote(vars.remoteRepo)} && git checkout -b ${shellQuote(branch)} ${shellQuote(`origin/${branch}`)}`,
          );
          if (coR.exitCode !== 0)
            throw new Error(
              `Branch create failed: ${coR.stderr.slice(-200) || coR.stdout.slice(-200)}`,
            );
          step('branch', `Created ${branch} tracking origin/${branch}`);
        }
      } else {
        const localExists =
          (
            await execOnSlot(
              vars,
              `cd ${shellQuote(vars.remoteRepo)} && git rev-parse --verify ${shellQuote(branch)} >/dev/null 2>&1`,
            )
          ).exitCode === 0;
        if (localExists) {
          if (forceNewBranch) {
            if (linkedWorktree) {
              await execOnSlot(
                vars,
                `cd ${shellQuote(vars.remoteRepo)} && git branch -D ${shellQuote(branch)} 2>/dev/null`,
              );
            } else {
              await execOnSlot(
                vars,
                `cd ${shellQuote(vars.remoteRepo)} && git checkout ${defaultBranch} 2>/dev/null && git branch -D ${shellQuote(branch)} 2>/dev/null`,
              );
            }
            await execOnSlot(
              vars,
              `cd ${shellQuote(vars.remoteRepo)} && git checkout -b ${shellQuote(branch)} ${shellQuote(newBranchBase)}`,
            );
            step('branch', `Recreated local ${branch} from ${newBranchBaseLabel}`);
          } else {
            await execOnSlot(
              vars,
              `cd ${shellQuote(vars.remoteRepo)} && git checkout ${shellQuote(branch)}`,
            );
            step('branch', `Switched to existing local ${branch}`);
          }
        } else {
          await execOnSlot(
            vars,
            `cd ${shellQuote(vars.remoteRepo)} && git checkout -b ${shellQuote(branch)} ${shellQuote(newBranchBase)}`,
          );
          step('branch', `Created ${branch} from ${newBranchBaseLabel}`);
        }
      }
    }
  }

  // 2c. Merge main (opt-in only for review-pr; worker flows use explicit mergeMain)
  if (mergeMain && branch) {
    const mergeStrategy = resolvePrepareMergeMainStrategy(
      projectJson,
      params.flowType,
      params.mergeMainStrategy as 'merge' | 'rebase' | undefined,
    );
    const softFailIntegration = shouldSoftFailPrepareIntegration(params.flowType);
    const linkedWorktree = await detectLinkedWorktree(vars);
    const resetToOriginBranch = async (detail: string) => {
      await execOnSlot(
        vars,
        `cd ${shellQuote(vars.remoteRepo)} && git checkout ${shellQuote(branch)} 2>/dev/null && git reset --hard ${shellQuote(`origin/${branch}`)} 2>/dev/null`,
      );
      step('merge', detail);
    };
    step('merge', `Fetching origin/${defaultBranch} before integrate-main...`);
    const fetchDefaultR = await execOnSlot(
      vars,
      `cd ${shellQuote(vars.remoteRepo)} && git fetch origin ${shellQuote(remoteBranchRefspec(defaultBranch))}`,
    );
    if (fetchDefaultR.exitCode !== 0) {
      const fetchErr =
        fetchDefaultR.stderr.slice(-200) || fetchDefaultR.stdout.slice(-200) || 'unknown error';
      if (softFailIntegration) {
        await resetToOriginBranch(
          `Fetch origin/${defaultBranch} failed — reviewing branch at origin/${branch} instead (${fetchErr})`,
        );
      } else {
        throw new Error(
          `git fetch origin ${defaultBranch} failed on ${vars.slotId} (${vars.remoteRepo}): ${fetchErr}`,
        );
      }
    } else if (mergeStrategy === 'rebase') {
      step('merge', `Rebasing ${branch} onto origin/${defaultBranch}...`);
      const rebaseR = await execOnSlot(
        vars,
        `cd ${shellQuote(vars.remoteRepo)} && git rebase ${shellQuote(`origin/${defaultBranch}`)} 2>&1`,
      );
      const rebaseConflict =
        rebaseR.exitCode !== 0 ||
        /CONFLICT|could not apply|patch failed/i.test(rebaseR.stdout + rebaseR.stderr);
      if (rebaseConflict) {
        await execOnSlot(
          vars,
          `cd ${shellQuote(vars.remoteRepo)} && git rebase --abort 2>/dev/null`,
        );
        if (softFailIntegration) {
          await resetToOriginBranch(
            `Rebase onto origin/${defaultBranch} conflicted — reviewing branch at origin/${branch} instead`,
          );
        } else {
          throw new Error(`Rebase conflict — PR author must rebase/merge ${defaultBranch}`);
        }
      } else {
        step('merge', `Rebased ${branch} onto origin/${defaultBranch}`);
      }
    } else {
      step('merge', `Merging origin/${defaultBranch}...`);
      const mergeR = await execOnSlot(
        vars,
        `cd ${shellQuote(vars.remoteRepo)} && git merge ${shellQuote(`origin/${defaultBranch}`)} --no-edit 2>&1`,
      );
      const mergeConflict = /CONFLICT|merge failed|Automatic merge failed/i.test(
        mergeR.stdout + mergeR.stderr,
      );
      if (mergeConflict) {
        const abortCmd = linkedWorktree
          ? `cd ${shellQuote(vars.remoteRepo)} && git merge --abort 2>/dev/null`
          : `cd ${shellQuote(vars.remoteRepo)} && git merge --abort 2>/dev/null; git checkout ${defaultBranch} 2>/dev/null`;
        await execOnSlot(vars, abortCmd);
        if (softFailIntegration) {
          await resetToOriginBranch(
            `Merge origin/${defaultBranch} conflicted — reviewing branch at origin/${branch} instead`,
          );
        } else {
          throw new Error(`Merge conflict — PR author must rebase/merge ${defaultBranch}`);
        }
      } else {
        step('merge', `Merged origin/${defaultBranch} into ${branch}`);
      }
    }
  }

  // 3. Fixtures — after checkout/reset/merge so tracked fixture outputs (for
  // example AGENTS.md) survive branch resets, but before dependency install so
  // project setup files such as .tool-versions are in place. Profile-gated
  // inside syncFixtures.
  await syncFixtures();

  // 3b. Install deps. Always install after a checkout when the phase is
  // enabled: skip-heuristics (lockHash before/after, .yarn-state.yml present)
  // miss the common case where a slot inherits node_modules from a prior
  // branch whose yarn.lock had different deps. `yarn install --immutable` is a
  // fast no-op when node_modules already matches the lock, so the cost of
  // always running is bounded; the cost of skipping incorrectly is a 240s
  // preflight timeout on the next webpack run. Profiles that skip this phase
  // declare deps_current so the fallback chain catches stale trees.
  if (!phaseEnabled('deps')) {
    step('deps', `Deps install skipped (profile ${profileName()})`);
  } else {
    const installCmd = expandPrepareHook('post_merge_install') || 'yarn install --frozen-lockfile';
    checkAborted();
    step('deps', `Installing deps: ${installCmd}`);
    const depsLogPath = phaseLog('deps');
    let depsLastOutputAt = Date.now();
    const depsHeartbeat = setInterval(() => {
      const silenceMs = Date.now() - depsLastOutputAt;
      if (silenceMs >= 30_000) {
        const min = Math.floor(silenceMs / 60_000);
        const sec = Math.floor((silenceMs % 60_000) / 1_000);
        const elapsed = min > 0 ? `${min}m${sec}s` : `${sec}s`;
        step('deps', `Still running… (${elapsed} since last output)`);
      }
    }, 30_000);
    let installR;
    try {
      installR = await runPrepareCommand(
        vars,
        depsLogPath,
        withProfileEnv(`cd ${shellQuote(vars.remoteRepo)} && ${applyCommandEnv(installCmd)}`),
        {
          cwd: vars.remoteRepo,
          timeout: depsTimeoutMs,
          signal,
          windowLabel,
          phase: 'deps',
          onOutput: (outputStream, data) => {
            depsLastOutputAt = Date.now();
            stream.output(outputStream === 'stderr' ? 'stderr' : 'stdout', data);
          },
        },
      );
    } finally {
      clearInterval(depsHeartbeat);
    }
    if (installR.exitCode !== 0) {
      const err: PrepareCommandError = new Error(
        `${installCmd} failed (exit ${installR.exitCode}) — log: ${depsLogPath}`,
      );
      err.failedCommand = installCmd;
      err.failedLogPath = depsLogPath;
      throw err;
    }
    // Record the lockfile hash so deps_current precondition checks can prove
    // the installed tree matches the checked-out lockfiles.
    await execOnSlot(vars, buildDepsSentinelWriteCommand(vars.remoteRepo, runtimeDir));
    step('deps', `Dependencies installed (log: ${depsLogPath})`);
  }

  await installEvalRecipeHarness();

  // 4. Ensure tmux session
  const session = await resolveTmuxSession(vars.slotId, vars);
  const tmuxR = await execOnSlot(
    vars,
    tmuxShellSnippet(`has-session -t ${shellQuote(session)} 2>/dev/null`),
  );
  if (tmuxR.exitCode === 0) {
    step('tmux', `tmux session ${session} exists`);
  } else {
    await execOnSlot(
      vars,
      tmuxShellSnippet(
        `new-session -d -s ${shellQuote(session)} -c ${shellQuote(vars.remoteRepo)}`,
      ),
    );
    step('tmux', `Created tmux session ${session}`);
  }

  // 5a. Kill any pre-existing dev server so preflight starts with a clean port.
  //     Prevents port conflict when preflight's expo build briefly spawns its own
  //     bundler on the same port — the post-build port-free check would otherwise
  //     see our pre-existing Metro and abort.
  //     Skipped when the profile overrides the preflight hook: a profile-supplied
  //     preflight (e.g. relaunch) owns the dev-server lifecycle and typically
  //     exists to keep the warm server alive.
  const preflightOverridden = Boolean(prepareProfile?.hooks.preflight);
  if (phaseEnabled('preflight') && !preflightOverridden) {
    const devServerPort = vars.resourceVars.port;
    const devServerCleanup = buildDevServerPortCleanup(devServerPort, slotIsLocal);
    if (devServerCleanup.command) {
      await execOnSlot(vars, devServerCleanup.command, vars.remoteRepo);
      step('preflight', 'Killed pre-existing dev server');
    } else if (devServerCleanup.skippedReason) {
      step('preflight', devServerCleanup.skippedReason);
    }
  } else if (phaseEnabled('preflight')) {
    step('preflight', 'Dev-server port cleanup skipped: profile overrides the preflight hook');
  }

  // 5b. Run preflight
  if (!phaseEnabled('preflight')) {
    step('preflight', `Preflight skipped (profile ${profileName()})`);
  }
  let preflightHook = phaseEnabled('preflight') ? expandPrepareHook('preflight') : '';
  if (preflightHook && opts?.stripClean) {
    preflightHook = preflightHook.replace(/\s*--clean\b/g, '');
    step('preflight', 'Recovery mode — skipping --clean rebuild');
  }
  if (preflightHook) {
    const preflightPidPath = path.join(vars.remoteRepo, runtimeDir, 'preflight.pid');
    const rawCleanupPatterns = getProjectFieldRaw(projectJson, 'cleanup_patterns');
    const cleanupPatterns = Array.isArray(rawCleanupPatterns)
      ? rawCleanupPatterns.map((p) => expandTemplate(String(p), vars, projectVars)).filter(Boolean)
      : [];
    await clearStalePrepareProcess(vars, preflightPidPath, 'preflight', cleanupPatterns);
    checkAborted();
    step('preflight', `Running preflight (${devServerName})...`);
    console.log(`[prepare] preflight hook: ${preflightHook}`);
    const preflightLogPath = phaseLog('preflight');
    let currentPreflightPhase = '';
    let phaseBuffer = '';
    const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    const varExports: string[] = [`export FARMSLOT_PREPARE_PROFILE=${shellQuote(profileName())}`];
    for (const [rawKey, rawValue] of Object.entries(params.vars ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(rawKey)) {
        throw new Error(`Invalid --var key '${rawKey}' (must match [A-Za-z_][A-Za-z0-9_]*)`);
      }
      varExports.push(
        `export FARMSLOT_VAR_${rawKey.toUpperCase()}=${shellQuote(String(rawValue))}`,
      );
    }
    const wrappedPreflightHook = [
      `PREP_PID_FILE=${shellQuote(preflightPidPath)}`,
      `echo $$ > "$PREP_PID_FILE"`,
      `cleanup_prepare_pid(){ rm -f "$PREP_PID_FILE"; }`,
      `trap cleanup_prepare_pid EXIT INT TERM`,
      ...varExports,
      applyCommandEnv(preflightHook),
    ].join('; ');

    // Build log tailing: watch preflight log files so heavy build output
    // (expo/xcodebuild) is streamed through the same emit pathway.
    // Local slots only — remote needs agent fs.watch support.
    const logWatchers: FSWatcher[] = [];
    if (slotIsLocal) {
      const prefLogConfig = getProjectFieldRaw(projectJson, 'preflight_logs');
      if (Array.isArray(prefLogConfig)) {
        for (const logTemplate of prefLogConfig) {
          const logFilePath = path.join(
            vars.remoteRepo,
            expandTemplate(logTemplate, vars, projectVars),
          );
          let offset = 0;
          try {
            offset = (await fsStat(logFilePath)).size;
          } catch {
            /* file doesn't exist yet */
          }
          let reading = false;
          const readNew = async () => {
            if (reading) return; // prevent concurrent reads on rapid change events
            reading = true;
            try {
              const chunk = await readPrepareLogTailChunk(logFilePath, offset);
              offset = chunk.offset;
              if (chunk.output) stream.output('stdout', chunk.output);
            } catch {
              /* file may not exist yet */
            }
            reading = false;
          };
          const w = chokidarWatch(logFilePath, { persistent: false, ignoreInitial: true });
          w.on('add', readNew);
          w.on('change', readNew);
          logWatchers.push(w);
        }
      }
    }

    let preflightR;
    try {
      preflightR = await runPrepareCommand(vars, preflightLogPath, wrappedPreflightHook, {
        cwd: vars.remoteRepo,
        timeout: preflightTimeoutMs,
        signal,
        windowLabel,
        phase: 'preflight',
        onOutput: (outputStream, data) => {
          stream.output(outputStream === 'stderr' ? 'stderr' : 'stdout', data);
          phaseBuffer += stripAnsi(data);
          const lines = phaseBuffer.split('\n');
          phaseBuffer = lines.pop() ?? '';
          for (const rawLine of lines) {
            const line = rawLine.trim();
            const phaseMatch = line.match(/\[(\d+)\/(\d+)\]\s*(.+)$/);
            if (!phaseMatch) continue;
            currentPreflightPhase = `[${phaseMatch[1]}/${phaseMatch[2]}] ${phaseMatch[3].trim()}`;
            step('preflight', `Running preflight (${devServerName}) — ${currentPreflightPhase}`);
          }
        },
      });
    } finally {
      for (const w of logWatchers) await w.close();
    }

    stream.output('stdout', `prepare log: ${preflightLogPath}\n`);
    if (preflightR.exitCode !== 0) {
      console.log(
        `[prepare] preflight failed (exit ${preflightR.exitCode}) log=${preflightLogPath}`,
      );
      const phaseLabel = currentPreflightPhase ? ` during ${currentPreflightPhase}` : '';
      const err: PrepareCommandError = new Error(
        `Preflight failed${phaseLabel} (exit ${preflightR.exitCode}) — log: ${preflightLogPath}`,
      );
      err.failedCommand = preflightHook;
      err.failedLogPath = preflightLogPath;
      err.failedPhase = currentPreflightPhase || undefined;
      err.relatedLogs = [
        path.join(vars.remoteRepo, runtimeDir, 'metro.log'),
        ...(vars.platform === 'ios'
          ? [path.join(vars.remoteRepo, runtimeDir, 'ios-expo-build.log')]
          : [path.join(vars.remoteRepo, runtimeDir, 'android-build.log')]),
      ];
      throw err;
    }
    const phaseSuffix = currentPreflightPhase ? ` after ${currentPreflightPhase}` : '';
    step('preflight', `Preflight completed${phaseSuffix} (log: ${preflightLogPath})`);
  }

  // 6. Verify health
  const healthHook = phaseEnabled('health') ? expandPrepareHook('health_check') : '';
  if (!phaseEnabled('health')) {
    step('health', `Health check skipped (profile ${profileName()})`);
  }
  if (healthHook) {
    step('health', 'Verifying health...');
    const parseCmd = getProjectField(projectJson, 'health.parse_health');
    let healthValue = await runHealthCheck(vars, withProfileEnv(healthHook), parseCmd);

    if (readyIndicator && healthValue !== readyIndicator) {
      // Try unlock
      const unlockHook = expandPrepareHook('unlock');
      if (unlockHook) {
        step('health', 'Trying unlock...');
        await execOnSlot(
          vars,
          `cd ${shellQuote(vars.remoteRepo)} && ${withProfileEnv(unlockHook)} 2>&1`,
        );
        await new Promise((r) => setTimeout(r, 3000));
        healthValue = await runHealthCheck(vars, withProfileEnv(healthHook), parseCmd);
      }
      if (readyIndicator && healthValue !== readyIndicator) {
        const err: PrepareCommandError = new Error(
          `Health not ready (value=${healthValue || 'none'}, expected ${readyIndicator})`,
        );
        err.failedCommand = healthHook;
        throw err;
      }
    }
    step('health', `Health check — ${healthValue}`);
  }

  // Operator-driven warm switch: bind this run to the slot so resume / recipe
  // replay target it (the recipe-rerun gate accepts a slot whose current_run_id
  // is this run and which is not mid-worker). Pure association — no pipeline
  // re-drive, unlike run.activateOnSlot. Compare-and-set so a direct RPC can
  // never stomp a slot another run already owns (a free or self-owned slot is
  // the only safe target).
  if (params.bindRunId) {
    await bindRunToSlot(params, vars, step);
  }

  // Keep the cached slot.branch truthful: prepare just put HEAD on `branch`, so
  // persist it. Otherwise the cache only refreshes on a full deep slot-check and
  // drifts after a cheap warm switch (state-on-write).
  if (branch) {
    await updateSlotStatus(params.slotId, { branch });
  }

  return {
    prepared: true,
    profile: {
      selected: prepareProfile.name,
      ...(params.prepareProfile ? { requested: params.prepareProfile } : {}),
      fallbacks: profileSelection.fallbacks,
    },
    ...(resolvedStartRef ? { startRef: resolvedStartRef } : {}),
  };
}

// ─── slotRelease — native TS port of release-slot.sh ───
