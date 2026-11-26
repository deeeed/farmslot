import type { ExecResult } from '@farmslot/protocol';

/** A probe that did not finish within its deadline, or a batch that could not run. */
export type SlotProbeOutcome = ExecResult | undefined;

const RECORD = '\u001e';
const FIELD = '\u001f';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * One shell that runs a slot's independent probes in parallel, each in its own subshell from the
 * slot checkout, and reports every probe's exit code, stdout and stderr. A probe still running at
 * the deadline is killed with its descendants and reported as timed out; the others keep their
 * results.
 *
 * Each probe also holds the batch's stdout open on fd 3, as a probe run on its own holds its
 * output pipe: a caller that cancels the batch keeps escalating until every probe process is gone.
 * A batch that is hung up, interrupted or terminated kills every probe tree first.
 */
export function slotProbeScript(commands: readonly string[], timeoutSeconds: number): string {
  const ids = commands.map((_, index) => index).join(' ');
  return [
    'd=$(mktemp -d "${TMPDIR:-/tmp}/farmslot-probe.XXXXXX") || exit 97',
    `trap 'rm -rf "$d"' EXIT`,
    // Stopped before its children are listed, so no process forks past the sweep.
    'k() { kill -STOP "$1" 2>/dev/null; for c in $(pgrep -P "$1" 2>/dev/null); do k "$c"; done; kill -9 "$1" 2>/dev/null; }',
    `trap 'k "$w"; for id in ${ids}; do eval "k \\"\\$p$id\\""; done; exit 143' HUP INT TERM`,
    ...commands.map(
      (command, id) =>
        `( eval ${quote(command)} ) 3>&1 >"$d/${id}.out" 2>"$d/${id}.err" </dev/null & p${id}=$!`,
    ),
    // One watchdog for the batch: every probe has the same deadline and started together.
    `( sleep ${timeoutSeconds}; for id in ${ids}; do eval "p=\\$p$id"; ` +
      `kill -0 "$p" 2>/dev/null && { : >"$d/$id.timeout"; k "$p"; }; done ) & w=$!`,
    ...commands.map((_, id) => `wait $p${id} 2>/dev/null; echo $? >"$d/${id}.code"`),
    'k "$w"',
    `for id in ${ids}; do ` +
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

/**
 * Runs a slot's probes as one batch, or as two when some of them call farm scripts. A farm-script
 * command waits for the node support bundle first, and a delivery still running when the batch's
 * budget ends returns no output at all. Batched together, that empty answer erased the probes
 * that need no bundle: a slot on `main` read as branch `-`. Kept apart, only the bundle's probes
 * wait on it. A slot with no farm-script probe still runs one batch, one round trip.
 *
 * `runBatch` returns the batch's stdout, or undefined when the batch could not run.
 */
export async function runSlotProbeBatches(
  commands: ReadonlyArray<string | undefined>,
  options: {
    needsBundle: (command: string) => boolean;
    timeoutSeconds: number;
    runBatch: (script: string) => Promise<string | undefined>;
  },
): Promise<SlotProbeOutcome[]> {
  const present = commands.flatMap((command, index) => (command ? [{ command, index }] : []));
  const results: SlotProbeOutcome[] = commands.map(() => undefined);
  const groups = [
    present.filter((entry) => !options.needsBundle(entry.command)),
    present.filter((entry) => options.needsBundle(entry.command)),
  ].filter((group) => group.length > 0);
  await Promise.all(
    groups.map(async (group) => {
      const stdout = await options.runBatch(
        slotProbeScript(
          group.map((entry) => entry.command),
          options.timeoutSeconds,
        ),
      );
      if (stdout === undefined) return;
      parseSlotProbeOutput(stdout, group.length).forEach((result, position) => {
        results[group[position].index] = result;
      });
    }),
  );
  return results;
}
