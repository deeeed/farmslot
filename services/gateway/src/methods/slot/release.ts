import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  AGENT_ROLES,
  type AgentRole,
  agentRoleWindow,
  DEFAULT_BRANCH,
  type SlotReleaseParams,
} from '@farmslot/protocol';

import {
  WORKER_ARTIFACT_COPY_EXCLUDES,
  WORKER_ARTIFACT_COPY_RELATIVE_EXCLUDES,
} from '../../core/artifact-copy-policy.js';
import {
  execOnSlot,
  expandHook,
  expandRecycleCmd,
  getOrchestratorTaskRoot,
  getProjectField,
  loadProjectVars,
  loadSlotVars,
  markSlotBusy,
  type ProjectVars,
  type RawProjectJson,
  readSlotField,
  resetSlot,
  resolveProjectTaskDirName,
  type SlotVars,
  updateSlotStatus,
} from '../../core/index.js';
import { slotCopyDir, SlotCopyDirEntryError } from '../../core/slot-io.js';
import {
  firstWindowTarget,
  resolveTmuxSession,
  shellQuote,
  tmuxSendTextCommand,
  tmuxShellSnippet,
} from '../../core/tmux.js';
import { cleanupSlotStorage } from '../../fleet/slot-storage-cleanup.js';
import { findRunnerDescendantPid } from '../../runners/session-process.js';
import { killSlotScreenSessions } from '../../runtime/screen-session.js';

import { isGateHeldPublicationRun } from '../../run-engine/gate-held-lifecycle.js';
import { listRuns } from '../../runs/store.js';
import { slotPrepare } from './prepare.js';
import { detachRunsForReleasedSlot } from './release-run-ownership.js';
import { applySelectedApp, type EventEmitter } from './shared.js';

export async function slotRelease(
  params: SlotReleaseParams,
  emit: EventEmitter,
): Promise<{ released: boolean }> {
  const vars = await loadSlotVars(params.slotId);
  await applySelectedApp(vars);

  let projectVars: ProjectVars | undefined;
  let projectJson: RawProjectJson = {};
  try {
    projectVars = await loadProjectVars(vars.projectName);
    projectJson = projectVars.projectJson;
  } catch {
    /* no project config */
  }

  const defaultBranch = getProjectField(projectJson, 'default_branch') || DEFAULT_BRANCH;
  const keepWarm = params.keepWarm ?? false;
  const keepWork = params.keepWork ?? false;
  const skipArtifacts = params.skipArtifacts ?? false;
  const forceReset = params.forceReset ?? false;
  const detachRuns = params.detachRuns ?? true;
  const preserveAgents = params.preserveAgents ?? false;
  const requestId = params.requestId ?? `release-${randomUUID()}`;
  const gateHeldRun = listRuns().find(
    (run) => run.slotId === params.slotId && isGateHeldPublicationRun(run),
  );
  if (gateHeldRun && !preserveAgents && !forceReset) {
    throw new Error(
      `Slot ${params.slotId} is gate-held for run ${gateHeldRun.id} — resolve or cancel the publication gate before release`,
    );
  }
  const startTime = Date.now();

  const out = (line: string) =>
    emit('script.output', {
      requestId,
      stream: 'stdout' as const,
      data: line.endsWith('\n') ? line : `${line}\n`,
      timestamp: Date.now(),
    });
  const complete = (exitCode: number) =>
    emit('script.complete', {
      requestId,
      exitCode,
      duration: Date.now() - startTime,
    });
  const step = (name: string, detail: string) => {
    emit('slot.release.step', { requestId, slotId: params.slotId, name, detail });
    out(`[${name}] ${detail}`);
  };

  // Stop TASK.md watching
  const { unwatchSlot } = await import('../../tasks/watcher.js');
  await unwatchSlot(params.slotId);

  // Mark lifecycle
  await markSlotBusy(params.slotId, 'releasing');

  // 1. Kill running agent. Local-first publication gate-hold skips slotRelease at
  // COMPLETE entirely (see holdSlotForPublicationGate) and tears down via
  // killSlotAgents at FINALIZE. preserveAgents is for partial release call sites only.
  if (!preserveAgents) {
    step('agent', 'Killing agent...');
    await killAllAgentWindows(vars);
    await killAgentInSession(vars);
    step('agent', 'Agent killed');
  } else {
    step('agent', 'Preserving agent windows for human gate');
  }

  // 2. Safety check (skip if --keepWork, --forceReset, or --force implied by keepWarm)
  if (!keepWork && !forceReset) {
    const currentBranch = (
      await execOnSlot(
        vars,
        `git -C ${shellQuote(vars.remoteRepo)} rev-parse --abbrev-ref HEAD 2>/dev/null`,
      )
    ).stdout.trim();
    if (currentBranch && currentBranch !== defaultBranch) {
      const dirty = (
        await execOnSlot(
          vars,
          `git -C ${shellQuote(vars.remoteRepo)} status --porcelain 2>/dev/null | grep -v '^\?\? \.omc/' | grep -v '^\?\? \.task/' | grep -v '^\?\? \.claude/CLAUDE\\.local\\.md' | head -5`,
        )
      ).stdout.trim();
      const hasRemote =
        (
          await execOnSlot(
            vars,
            `git -C ${shellQuote(vars.remoteRepo)} rev-parse --verify ${shellQuote(`origin/${currentBranch}`)} 2>/dev/null && echo yes`,
          )
        ).stdout.trim() === 'yes';
      let unpushed = '';
      if (hasRemote) {
        unpushed = (
          await execOnSlot(
            vars,
            `git -C ${shellQuote(vars.remoteRepo)} log --oneline ${shellQuote(`origin/${currentBranch}..HEAD`)} 2>/dev/null | head -5`,
          )
        ).stdout.trim();
      } else {
        unpushed = (
          await execOnSlot(
            vars,
            `git -C ${shellQuote(vars.remoteRepo)} log --oneline ${shellQuote(`${defaultBranch}..HEAD`)} 2>/dev/null | head -5`,
          )
        ).stdout.trim();
      }
      if (dirty || unpushed) {
        // Check if the remote branch still exists — GitHub deletes branches after PR merge.
        // If gone from remote, the work was merged and there's nothing to lose.
        const remoteBranchExists =
          (
            await execOnSlot(
              vars,
              `git -C ${shellQuote(vars.remoteRepo)} ls-remote --heads origin ${shellQuote(currentBranch)} 2>/dev/null`,
            )
          ).stdout.trim() !== '';
        if (remoteBranchExists) {
          await markSlotBusy(params.slotId, 'working');
          const details = [dirty && 'dirty files', unpushed && 'unpushed commits']
            .filter(Boolean)
            .join(' + ');
          throw new Error(
            `UNMERGED_WORK:${currentBranch}:${details}:Slot has work on '${currentBranch}' (${details}) that would be lost. Use Force Reset to discard.`,
          );
        }
        console.log(
          `[slot.release] ${params.slotId}: remote branch '${currentBranch}' deleted (merged) — allowing recycle`,
        );
      }
    }
  }

  // 3. Collect artifacts + clean task files + git reset
  const taskDirName = resolveProjectTaskDirName(projectJson);
  if (!keepWork) {
    // Read task_file from status
    const taskRel = (await readSlotField(params.slotId, 'task_file')) as string | null;

    if (!skipArtifacts && taskRel) {
      step('artifacts', 'Collecting artifacts...');
      const workerArtifacts = `${vars.remoteRepo}/${taskDirName}/${taskRel}/artifacts`;
      const hasArtifacts =
        (
          await execOnSlot(vars, `test -d ${shellQuote(workerArtifacts)} && echo yes`)
        ).stdout.trim() === 'yes';
      if (hasArtifacts) {
        const orchTaskDir = path.join(
          getOrchestratorTaskRoot(vars.projectName, projectJson),
          taskRel,
        );
        const localArtifactsDir = path.join(orchTaskDir, 'artifacts');
        const entryFailures: SlotCopyDirEntryError[] = [];
        await slotCopyDir(vars, workerArtifacts, localArtifactsDir, {
          excludeTopLevel: [...WORKER_ARTIFACT_COPY_EXCLUDES],
          excludeRelativePaths: [...WORKER_ARTIFACT_COPY_RELATIVE_EXCLUDES],
          // Release-time copyback is best-effort: one transient EACCES on a
          // screenshot must not block reset of the whole slot. Per-file errors
          // are surfaced in the step breadcrumb so operators see partial copies.
          onEntryFailure: (err) => {
            entryFailures.push(err);
            console.warn(
              `[slot.release] artifact copy entry failure ${err.sourcePath}: ${err.message.slice(0, 200)}`,
            );
          },
        });
        if (entryFailures.length > 0) {
          step(
            'artifacts',
            `Artifacts collected to ${localArtifactsDir}/ (with ${entryFailures.length} per-file failure${entryFailures.length === 1 ? '' : 's'})`,
          );
        } else {
          step('artifacts', `Artifacts collected to ${localArtifactsDir}/`);
        }
      } else {
        step('artifacts', 'No artifacts directory');
      }
    }

    // Clean task files
    if (taskRel) {
      await execOnSlot(
        vars,
        `rm -rf ${shellQuote(`${vars.remoteRepo}/${taskDirName}/${taskRel}`)}`,
      );
      step('clean', `Task dir ${taskDirName}/${taskRel} cleaned`);
    }

    try {
      const storageCleanup = await cleanupSlotStorage(vars, projectJson, {
        // Release keeps warm resources alive, so only prune completed task
        // copies and runtime artifact buckets. Browser profile directories are
        // reserved for explicit slot.cleanup after resource shutdown.
        includeBrowserProfiles: false,
      });
      if (storageCleanup.deleted.length > 0 || storageCleanup.skipped.length > 0) {
        step(
          'storage-clean',
          `Pruned ${storageCleanup.deleted.length} stale slot director${storageCleanup.deleted.length === 1 ? 'y' : 'ies'}`,
        );
      } else {
        step('storage-clean', 'No stale slot directories');
      }
    } catch (err) {
      // Storage pruning is intentionally best-effort at release time: by this
      // point the active task artifacts have already been copied back, and a
      // stale-cache cleanup failure must not strand the slot in releasing.
      const detail = (err as Error).message.slice(0, 200);
      console.warn(`[slot.release] ${params.slotId}: storage cleanup skipped: ${detail}`);
      step('storage-clean', `Skipped stale storage cleanup: ${detail}`);
    }

    // Git reset to default branch
    step('git', `Returning to ${defaultBranch}...`);
    const currentBranch = (
      await execOnSlot(
        vars,
        `git -C ${shellQuote(vars.remoteRepo)} rev-parse --abbrev-ref HEAD 2>/dev/null`,
      )
    ).stdout.trim();
    if (currentBranch === defaultBranch) {
      step('git', `Already on ${defaultBranch}`);
    } else {
      await execOnSlot(
        vars,
        `cd ${shellQuote(vars.remoteRepo)} && git checkout -- . 2>/dev/null && git clean -fd 2>/dev/null && git checkout ${defaultBranch} 2>/dev/null && git pull origin ${defaultBranch} 2>/dev/null`,
      );
      step('git', `Returned to ${defaultBranch} (was ${currentBranch})`);
    }

    // Recycle app
    step('recycle', 'Recycling app...');
    const recycleCmd = vars.recycleCmd
      ? expandRecycleCmd(vars)
      : expandHook('recycle', projectJson, vars, projectVars);
    if (recycleCmd) {
      await execOnSlot(vars, recycleCmd);
      step('recycle', 'App recycled');
    } else {
      step('recycle', 'No recycle command configured');
    }
  }

  // 5. Teardown — DELIBERATELY DOES NOTHING for resources. Release flips
  // the slot back to ready but leaves the simulator / dev-server / browser
  // alive so the next run reuses warm infra and so a human-driven manual
  // build in the worktree isn't yanked out from under them.
  // Resource shutdown is a separate explicit user action via the
  // slot.cleanup RPC (cleanup button). The historical "fallback" that
  // ran `xcrun simctl shutdown` here was the source of the live-sim kill
  // problem; do not reintroduce it. Screen capture sessions are still
  // torn down because they're tied to a specific PID that's about to
  // change anyway.
  if (!keepWarm) {
    killSlotScreenSessions(params.slotId);
  }

  // 6. Update status fields
  if (!keepWork) {
    await updateSlotStatus(params.slotId, {
      task_id: null,
      task_file: null,
      runner: null,
      model: null,
      app: null,
      current_run_id: null,
      current_flow_type: null,
      current_ticket_or_pr: null,
      current_mode: null,
      current_family_id: null,
      current_lane: null,
      current_variant: null,
    });
  } else if (!keepWarm) {
    await updateSlotStatus(params.slotId, { app: null });
  }
  await updateSlotStatus(params.slotId, {
    completed_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    agent: 'idle',
  });

  // 7. Re-prepare if keep-warm, otherwise mark ready (cold)
  if (keepWarm) {
    step('reprepare', 'Re-preparing slot...');
    try {
      await slotPrepare({ slotId: params.slotId }, emit);
      await resetSlot(params.slotId, true);
    } catch (err) {
      step('reprepare', `Re-prepare had issues: ${(err as Error).message}`);
      await resetSlot(params.slotId, true);
    }
  } else {
    await resetSlot(params.slotId);
  }
  if (detachRuns) {
    const detachedRunIds = detachRunsForReleasedSlot(params.slotId, emit);
    if (detachedRunIds.length > 0) {
      step('runs', `Detached ${detachedRunIds.length} run(s) from released slot`);
    }
  }

  emit('slot.release.done', { requestId, slotId: params.slotId, keepWarm });
  complete(0);
  return { released: true };
}

/** Tear down role windows and runner processes without running a full slot release. */
export async function killSlotAgents(slotId: string): Promise<void> {
  const vars = await loadSlotVars(slotId);
  await killAllAgentWindows(vars);
  await killAgentInSession(vars);
}

// ─── slotRecycle — convenience wrapper ───

export async function killAgentInSession(
  vars: SlotVars,
  runner?: string,
  role: AgentRole = 'primary',
): Promise<void> {
  const TMUX_CMD_TIMEOUT = 10_000;
  const session = await resolveTmuxSession(vars.slotId, vars);
  const roleWindow = agentRoleWindow(role);
  const hasSession =
    (
      await execOnSlot(
        vars,
        tmuxShellSnippet(`has-session -t ${shellQuote(session)} 2>/dev/null`),
        { timeout: TMUX_CMD_TIMEOUT },
      )
    ).exitCode === 0;
  if (!hasSession) return;

  // Resolve the cleanup target the same way dispatch does — `${session}:0`
  // doesn't exist on hosts where tmux is configured with `base-index 1`
  // (mini.local + many community confs). Using firstWindowTarget keeps the
  // kill path aligned with renameDefaultWorkerWindow / ensureWorkerRoleTarget
  // / waitForRunnerProcessExit so a runner alive in `${session}:1` actually
  // gets interrupted instead of orphaned through a no-op cleanup.
  const target = roleWindow ? `${session}:${roleWindow}` : await firstWindowTarget(vars, session);

  const hasTarget =
    (
      await execOnSlot(
        vars,
        tmuxShellSnippet(
          `list-panes -t ${shellQuote(target)} -F '#{pane_pid}' 2>/dev/null | head -1`,
        ),
        { timeout: TMUX_CMD_TIMEOUT },
      )
    ).exitCode === 0;
  if (!hasTarget) return;

  const panePid = (
    await execOnSlot(
      vars,
      tmuxShellSnippet(
        `list-panes -t ${shellQuote(target)} -F '#{pane_pid}' 2>/dev/null | head -1`,
      ),
      { timeout: TMUX_CMD_TIMEOUT },
    )
  ).stdout.trim();
  if (!panePid) return;

  // Walk descendants instead of pgrep -P direct children — a project with a
  // wrapping `dispatch_cmd` (e.g. `bash -lc 'codex …'`) makes the runner a
  // grandchild of the pane shell, and the old check returned empty, skipping
  // the graceful `/exit` step entirely. The kill -TERM/KILL fallback below
  // operates on the actual runner PID, so the descendant walk needs to
  // surface that PID, not just a boolean.
  const agentPid = await findRunnerDescendantPid(vars, panePid, runner);

  if (agentPid) {
    await execOnSlot(vars, tmuxSendTextCommand(target, '/exit', { enter: true }), {
      timeout: TMUX_CMD_TIMEOUT,
    });
    await new Promise((r) => setTimeout(r, 2000));

    const stillAlive =
      (
        await execOnSlot(vars, `kill -0 ${shellQuote(agentPid)} 2>/dev/null`, {
          timeout: TMUX_CMD_TIMEOUT,
        })
      ).exitCode === 0;
    if (stillAlive) {
      await execOnSlot(vars, `kill -TERM ${shellQuote(agentPid)} 2>/dev/null`, {
        timeout: TMUX_CMD_TIMEOUT,
      });
      await new Promise((r) => setTimeout(r, 1000));
      await execOnSlot(
        vars,
        `kill -0 ${shellQuote(agentPid)} 2>/dev/null && kill -KILL ${shellQuote(agentPid)} 2>/dev/null`,
        { timeout: TMUX_CMD_TIMEOUT },
      );
    }
  }

  await new Promise((r) => setTimeout(r, 1000));
  const shellAlive =
    (
      await execOnSlot(vars, `kill -0 ${shellQuote(panePid)} 2>/dev/null && echo yes`, {
        timeout: TMUX_CMD_TIMEOUT,
      })
    ).stdout.trim() === 'yes';

  if (shellAlive) {
    await execOnSlot(vars, tmuxShellSnippet(`send-keys -t ${shellQuote(target)} C-c 2>/dev/null`), {
      timeout: TMUX_CMD_TIMEOUT,
    });
    await new Promise((r) => setTimeout(r, 300));
    await execOnSlot(vars, tmuxShellSnippet(`send-keys -t ${shellQuote(target)} C-c 2>/dev/null`), {
      timeout: TMUX_CMD_TIMEOUT,
    });
    await new Promise((r) => setTimeout(r, 300));
    await execOnSlot(
      vars,
      tmuxSendTextCommand(target, `cd ${vars.remoteRepo}`, { enter: true, suffix: '2>/dev/null' }),
      { timeout: TMUX_CMD_TIMEOUT },
    );
  } else {
    await execOnSlot(
      vars,
      tmuxShellSnippet(
        `respawn-pane -k -t ${shellQuote(target)} ${shellQuote(`cd ${vars.remoteRepo} && exec \${SHELL:-bash}`)} 2>/dev/null`,
      ),
      { timeout: TMUX_CMD_TIMEOUT },
    );
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export async function killAllAgentWindows(
  vars: SlotVars,
  sessionOverride?: string,
  options?: { exclude?: ReadonlyArray<AgentRole> },
): Promise<void> {
  const TMUX_CMD_TIMEOUT = 10_000;
  const session = sessionOverride ?? (await resolveTmuxSession(vars.slotId, vars));
  const hasSession =
    (
      await execOnSlot(
        vars,
        tmuxShellSnippet(`has-session -t ${shellQuote(session)} 2>/dev/null`),
        { timeout: TMUX_CMD_TIMEOUT },
      )
    ).exitCode === 0;
  if (!hasSession) return;

  const excluded = new Set<string>(
    (options?.exclude ?? [])
      .map((role) => agentRoleWindow(role))
      .filter((name): name is string => Boolean(name)),
  );
  const roleWindowNames = new Set(
    AGENT_ROLES.map((role) => agentRoleWindow(role))
      .filter((name): name is string => Boolean(name))
      .filter((name) => !excluded.has(name)),
  );
  const maxKillAttempts = AGENT_ROLES.length + 2;
  for (let attempt = 1; attempt <= maxKillAttempts; attempt += 1) {
    const listed = await execOnSlot(
      vars,
      tmuxShellSnippet(
        `list-windows -t ${shellQuote(session)} -F '#{window_index}\t#{window_name}' 2>/dev/null`,
      ),
      { timeout: TMUX_CMD_TIMEOUT },
    );
    if (listed.exitCode !== 0) return;

    const windows = listed.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [index, name] = line.split('\t', 2);
        return { index, name };
      });
    const roleWindow = windows.find(
      (window) => window.index && window.name && roleWindowNames.has(window.name),
    );
    if (!roleWindow) return;

    const target = `${session}:${roleWindow.index}`;
    const command = buildKillRoleWindowCommand(session, target, windows.length, vars.remoteRepo);
    const killed = await execOnSlot(vars, tmuxShellSnippet(command), { timeout: TMUX_CMD_TIMEOUT });
    if (killed.exitCode !== 0) {
      throw new Error(
        `Failed to kill tmux role window ${target}: ${killed.stderr || killed.stdout || `exit ${killed.exitCode}`}`,
      );
    }
  }
  throw new Error(
    `Exceeded ${maxKillAttempts} attempts to kill tmux role windows for session ${session}; role windows may be respawning`,
  );
}

export function buildKillRoleWindowCommand(
  session: string,
  target: string,
  windowCount: number,
  remoteRepo: string,
): string {
  if (windowCount <= 1) {
    // tmuxShellSnippet() prefixes a single tmux binary invocation. Use tmux's
    // command separator rather than shell `&&`; otherwise the second command
    // runs as a shell command (`kill-window`) and fails with exit 127.
    return `new-window -t ${shellQuote(session)} -n worker -c ${shellQuote(remoteRepo)} -d \\; kill-window -t ${shellQuote(target)} 2>/dev/null`;
  }
  return `kill-window -t ${shellQuote(target)} 2>/dev/null`;
}
