// self-review/worker-lifecycle.ts — worker liveness and relaunch target helpers for self-review fixes.

import { resolveAgentTarget } from '../agents/contexts.js';
import { loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { firstWindowTarget, shellQuote, tmuxShellSnippet } from '../core/tmux.js';
import { resolvePrimaryWorkerTarget, runnerProcessPatternSource } from '../runners/registry.js';

export async function ensureTmuxTargetReadyForRelaunch(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  session: string,
  target: string,
  roleWindowName?: string | null,
): Promise<string> {
  const sessionReady =
    (await execOnSlot(vars, tmuxShellSnippet(`has-session -t ${shellQuote(session)} 2>/dev/null`)))
      .exitCode === 0;
  if (!sessionReady) {
    const created = await execOnSlot(
      vars,
      tmuxShellSnippet(
        `new-session -d -s ${shellQuote(session)} -c ${shellQuote(vars.remoteRepo)} 2>/dev/null`,
      ),
    );
    if (created.exitCode !== 0) {
      throw new Error(
        `Cannot relaunch worker because tmux session ${session} is missing: ${created.stderr || created.stdout || `exit ${created.exitCode}`}`,
      );
    }
  }

  const windowPart = target.includes(':')
    ? target.slice(target.indexOf(':') + 1).split('.', 1)[0]
    : '';
  const paneReady = (
    await execOnSlot(
      vars,
      tmuxShellSnippet(
        `list-panes -t ${shellQuote(target)} -F '#{pane_index}' 2>/dev/null | head -1`,
      ),
    )
  ).stdout.trim();
  let recreateWindow = windowPart;
  if (paneReady) {
    // Legacy dispatches stored numeric targets like mm-2:1.1 while the logical
    // role window was `dev`. Infra windows (metro-*) can take over that index
    // after the worker pane exits, so never treat a live pane at a numeric
    // index as the worker unless the window name still matches.
    if (/^\d+$/.test(windowPart)) {
      const windowName = (
        await execOnSlot(
          vars,
          tmuxShellSnippet(
            `display-message -p -t ${shellQuote(target)} '#{window_name}' 2>/dev/null`,
          ),
        )
      ).stdout.trim();
      if (windowName && windowName !== windowPart) {
        recreateWindow = roleWindowName?.trim() || '';
        console.warn(
          `[self-review] tmux target ${target} drifted to window ${windowName}; recreating role window ${recreateWindow || '(first window)'}`,
        );
      } else {
        return target;
      }
    } else {
      return target;
    }
  }
  // No parseable window in the supplied target, OR the caller asked for "0"
  // — both cases collapse to "give me the session's actual first window."
  // Resolve via firstWindowTarget so base-index-1 hosts get `${session}:1`
  // instead of the non-existent `${session}:0` the legacy fallback returned.
  if (!recreateWindow || recreateWindow === '0') return await firstWindowTarget(vars, session);

  const created = await execOnSlot(
    vars,
    tmuxShellSnippet(
      `new-window -t ${shellQuote(session)} -n ${shellQuote(recreateWindow)} -c ${shellQuote(vars.remoteRepo)} -d 2>/dev/null`,
    ),
  );
  if (created.exitCode !== 0) {
    throw new Error(
      `Cannot relaunch worker because tmux target ${target} is missing: ${created.stderr || created.stdout || `exit ${created.exitCode}`}`,
    );
  }
  return `${session}:${recreateWindow}`;
}

export async function isWorkerAlive(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  runner: string,
  runId?: string,
): Promise<boolean> {
  let workerTarget = '<unresolved>';
  try {
    workerTarget = runId
      ? (await resolveAgentTarget(vars.slotId, { runId, role: 'primary' })).target
      : await resolvePrimaryWorkerTarget(vars);
    const paneCommand = (
      await execOnSlot(
        vars,
        tmuxShellSnippet(
          `display-message -p -t ${shellQuote(workerTarget)} '#{pane_current_command}' 2>/dev/null`,
        ),
      )
    ).stdout
      .trim()
      .toLowerCase();
    const matcherParts = runnerProcessPatternSource(runner)
      .split('|')
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean);
    if (paneCommand && matcherParts.some((part) => paneCommand.includes(part))) {
      return true;
    }
    const result = await execOnSlot(
      vars,
      tmuxShellSnippet(
        `list-panes -t ${shellQuote(workerTarget)} -F '#{pane_pid}' 2>/dev/null | head -1 | xargs -I{} pgrep -P {} -f '${runnerProcessPatternSource(runner)}' 2>/dev/null | head -1`,
      ),
    );
    return result.stdout.trim().length > 0;
  } catch (err) {
    console.warn(
      `[self-review] failed to check worker liveness for ${workerTarget}: ${(err as Error).message}`,
    );
    return false;
  }
}
