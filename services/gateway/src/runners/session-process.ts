import path from 'node:path';

import { type loadSlotVars, resolveProjectRuntimeDir } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';

import { runnerPersistsSessionFiles, runnerProcessPatternSource } from './registry.js';

export async function listRunnerSessionFiles(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  runner: string,
): Promise<string[]> {
  if (!runnerPersistsSessionFiles(runner)) return [];
  const repo = vars.remoteRepo;
  // Codex runs with CODEX_HOME=<repo>/<runtimeDir>/codex-home (see buildCodexHomeSetup), so its
  // rollouts live there. Resolve the SAME runtime dir the launcher uses — no globbing/guessing.
  const runtimeDir = await resolveProjectRuntimeDir(vars.projectName);
  const script = `
python3 - <<'PY'
import json
from pathlib import Path
from time import time
from urllib.parse import quote
repo = ${JSON.stringify(repo)}
runner = ${JSON.stringify(runner)}
runtime_dir = ${JSON.stringify(runtimeDir)}
home = Path.home()
paths = []
if runner == 'claude':
    session_dir = home / '.claude' / 'projects' / repo.replace('/', '-')
    if session_dir.is_dir():
        paths = [str(p) for p in sorted(session_dir.glob('*.jsonl'), key=lambda p: p.stat().st_mtime, reverse=True)]
elif runner == 'grok':
    sessions_dir = home / '.grok' / 'sessions' / quote(repo, safe='')
    if sessions_dir.is_dir():
        cutoff = time() - (7 * 24 * 60 * 60)
        for summary_path in sorted(sessions_dir.glob('*/summary.json'), key=lambda p: p.stat().st_mtime, reverse=True):
            try:
                if summary_path.stat().st_mtime < cutoff:
                    continue
                summary = json.loads(summary_path.read_text())
                if summary.get('info', {}).get('cwd') == repo:
                    paths.append(str(summary_path.parent))
            except Exception:
                # Grok writes summary.json at runtime; skip partial/unreadable files during discovery.
                continue
else:
    # The worker's CODEX_HOME is the exact <repo>/<runtimeDir>/codex-home the launcher set, so
    # its rollouts live there — not ~/.codex/sessions. Use that exact path; only fall back to the
    # global home if the per-slot home is absent (e.g. observability install was skipped).
    sessions_root = Path(repo) / runtime_dir / 'codex-home' / 'sessions'
    if not sessions_root.is_dir():
        sessions_root = home / '.codex' / 'sessions'
    if sessions_root.is_dir():
        cutoff = time() - (7 * 24 * 60 * 60)
        seen = 0
        for path in sorted(sessions_root.rglob('*.jsonl'), key=lambda p: p.stat().st_mtime, reverse=True):
            if seen >= 200:
                break
            try:
                if path.stat().st_mtime < cutoff:
                    continue
                with path.open() as f:
                    first = json.loads(next(f))
                if first.get('type') == 'session_meta' and first.get('payload', {}).get('cwd') == repo:
                    paths.append(str(path))
                seen += 1
            except Exception:
                # Codex session discovery scans CLI-owned files; skip malformed/non-session files.
                continue
print(json.dumps(paths))
PY`;
  const result = await execOnSlot(vars, script);
  return JSON.parse(result.stdout || '[]') as string[];
}

export async function captureRunnerSessionMetadata(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  runner: string,
  beforePaths: string[],
): Promise<{ runnerSessionPath: string | null; runnerSessionId: string | null }> {
  if (!runnerPersistsSessionFiles(runner)) {
    return { runnerSessionPath: null, runnerSessionId: null };
  }
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const afterPaths = await listRunnerSessionFiles(vars, runner);
    const before = new Set(beforePaths);
    const fresh = afterPaths.filter((p) => !before.has(p));
    // Session discovery returns newest-first for every persisted runner.
    // If no new path appears, fall back to the newest known path, not the oldest.
    const chosen = fresh[0] ?? afterPaths[0] ?? null;
    if (chosen) {
      return {
        runnerSessionPath: chosen,
        runnerSessionId: path.basename(chosen, '.jsonl'),
      };
    }
  }
  return { runnerSessionPath: null, runnerSessionId: null };
}

/**
 * Find a runner-pattern process living anywhere in the descendant tree of
 * {@link panePid}. Returns the matching PID as a trimmed string, or `''` when
 * no descendant matches. Replaces the old `pgrep -P <panePid>` checks
 * scattered across dispatch / run-monitor / ci-monitor / slot.killAgentInSession
 * — `-P` matches only DIRECT children, so any project whose `dispatch_cmd`
 * wraps the runner (`bash -lc 'codex …'`, `nohup`, etc.) leaves the runner as
 * a *grandchild* and the old check missed it. The miss caused multiple
 * symmetric defects: monitor falsely reporting "worker done" before this PR's
 * launch hardening; `assertRunnerProcessStarted` now timing out on legitimate
 * dispatches; and `killAgentInSession` skipping the graceful `/exit` step
 * because `pgrep -P` returned nothing for wrapped runners.
 *
 * Strategy: find every PID matching the pattern (`pgrep -f`), then walk each
 * candidate's PPID chain up to either {@link panePid} (alive descendant) or
 * to PID 1 / 0 / empty (different process tree). The pattern is single-quoted
 * via {@link shellQuote} but uses egrep alternation, which is safe inside the
 * quotes — no callers pass user-controlled regex (the patterns come from the
 * runner registry's static `processMatchers`).
 *
 * `tr -d ' \\n\\r\\t'` strips every flavor of whitespace because BSD `ps`
 * (macOS) on a stale/non-existent PID can return a bare newline with exit 0
 * — `tr -d ' '` alone left a `\\n` in `cur` which made the loop predicate
 * `[ -n "$cur" ]` true forever, hanging the SSH exec until the outer timeout.
 *
 * Cost: O(matches × ancestor depth). On a real pane with a single runner that
 * is ~1 candidate × 2-4 levels — cheaper than the original pgrep -P call once
 * the SSH round-trip dominates.
 */
export async function findRunnerDescendantPid(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  panePid: string,
  runnerId?: string | null,
): Promise<string> {
  if (!panePid) return '';
  const pattern = runnerProcessPatternSource(runnerId);
  if (!pattern) return '';
  const cmd = [
    `root=${shellQuote(panePid)}`,
    `for pid in $(pgrep -f ${shellQuote(pattern)} 2>/dev/null); do`,
    `  cur=$pid`,
    `  while [ -n "$cur" ] && [ "$cur" != "$root" ] && [ "$cur" != "0" ] && [ "$cur" != "1" ]; do`,
    `    cur=$(ps -o ppid= -p "$cur" 2>/dev/null | tr -d ' \\n\\r\\t')`,
    `  done`,
    `  if [ "$cur" = "$root" ]; then echo "$pid"; exit 0; fi`,
    `done`,
    `exit 1`,
  ].join('\n');
  const result = await execOnSlot(vars, cmd);
  if (result.exitCode !== 0) return '';
  return result.stdout.trim();
}

/**
 * Boolean convenience wrapper around {@link findRunnerDescendantPid} for
 * callers that only need "is the runner alive somewhere under this pane?"
 * (run-monitor, ci-monitor, dispatch's wait-for-exit / wait-for-start polls).
 * `killAgentInSession` and any other caller that needs the PID itself
 * (graceful-exit signaling, kill -TERM/KILL fallback) should use the
 * underlying helper directly.
 */
export async function isRunnerAliveUnderPane(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  panePid: string,
  runnerId?: string | null,
): Promise<boolean> {
  return (await findRunnerDescendantPid(vars, panePid, runnerId)).length > 0;
}
