import type { ExecResult } from '@farmslot/protocol';

/** A probe that did not finish within its deadline, or a batch that could not run. */
export type SlotProbeOutcome = ExecResult | undefined;

const RECORD = '\u001e';
const FIELD = '\u001f';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * One shell that runs a slot's independent probes in parallel, each in its own subshell from the
 * slot checkout, and reports every probe's exit code, stdout and stderr. A probe still running at
 * the deadline is killed and reported as timed out; the others keep their results.
 */
export function slotProbeScript(commands: readonly string[], timeoutSeconds: number): string {
  const ids = commands.map((_, index) => index);
  return [
    'd=$(mktemp -d "${TMPDIR:-/tmp}/farmslot-probe.XXXXXX") || exit 97',
    `trap 'rm -rf "$d"' EXIT`,
    ...commands.map(
      (command, id) =>
        `( eval ${quote(command)} ) >"$d/${id}.out" 2>"$d/${id}.err" </dev/null & p${id}=$!`,
    ),
    // One watchdog for the batch: every probe has the same deadline and started together.
    `( sleep ${timeoutSeconds}; for id in ${ids.join(' ')}; do eval "p=\\$p$id"; ` +
      `kill -0 "$p" 2>/dev/null && { : >"$d/$id.timeout"; pkill -9 -P "$p" 2>/dev/null; kill -9 "$p" 2>/dev/null; }; done ) & w=$!`,
    ...ids.map((id) => `wait $p${id} 2>/dev/null; echo $? >"$d/${id}.code"`),
    'pkill -P "$w" 2>/dev/null; kill "$w" 2>/dev/null',
    `for id in ${ids.join(' ')}; do ` +
      `if [ -e "$d/$id.timeout" ]; then printf '${RECORD}%s${FIELD}timeout${FIELD}' "$id"; ` +
      `else printf '${RECORD}%s${FIELD}%s${FIELD}' "$id" "$(cat "$d/$id.code")"; fi; ` +
      `cat "$d/$id.out"; printf '${FIELD}'; cat "$d/$id.err"; done`,
  ].join('\n');
}

/** Each probe's result in command order; a timed-out or unreported probe is undefined. */
export function parseSlotProbeOutput(stdout: string, count: number): SlotProbeOutcome[] {
  const results: SlotProbeOutcome[] = Array.from({ length: count }, () => undefined);
  for (const record of stdout.split(RECORD).slice(1)) {
    const [id, code, out = '', err = ''] = record.split(FIELD);
    const index = Number(id);
    if (!Number.isInteger(index) || index < 0 || index >= count || code === 'timeout') continue;
    const exitCode = Number(code);
    if (!Number.isInteger(exitCode)) continue;
    results[index] = { stdout: out, stderr: err, exitCode };
  }
  return results;
}
