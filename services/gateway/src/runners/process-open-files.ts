import { shellQuote } from '../core/tmux.js';

/**
 * Files a process currently holds open, one path per `n`-prefixed line.
 *
 * This is the PRIMARY ownership evidence: a process holding the exact rollout
 * file open is a kernel fact about that pid, with no display formatting in the
 * way. `ps -o args=` flattens argv into one display string, so a value
 * containing spaces (`--config 'note = <uuid>'`) can masquerade as the
 * positional session id — argv can therefore reject, but never certify.
 */
export function buildRunnerOpenFileProbeCommand(pid: string): string {
  // macOS ships lsof in /usr/sbin, which is not on every non-login PATH. Same
  // candidate-resolution shape the tmux helper uses; a missing binary yields a
  // non-zero exit, which the caller reports as indeterminate, never a denial.
  return [
    'LSOF_BIN="$(command -v lsof 2>/dev/null || true)"',
    '[ -n "$LSOF_BIN" ] || [ ! -x /usr/sbin/lsof ] || LSOF_BIN=/usr/sbin/lsof',
    '[ -n "$LSOF_BIN" ] || { echo "lsof not found" >&2; exit 127; }',
    `"$LSOF_BIN" -p ${shellQuote(pid)} -F n 2>/dev/null`,
  ].join('; ');
}

/** Canonical paths held open by the probed process. */
export function parseOpenFilePaths(lsofOutput: string): string[] {
  return lsofOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('n') && line.length > 1)
    .map((line) => line.slice(1));
}
