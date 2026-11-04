import { execOnSlot, type SlotVars } from '../core/index.js';

import type { ProcessCensusRow } from './process-census.js';

interface ProcessReapResult {
  total: number;
  survivors: ProcessCensusRow[];
}

/** Stop identified roots and descendants, checking ownership and process start times before signals. */
export async function reapIdentifiedSlotProcesses(
  vars: SlotVars,
  rows: ProcessCensusRow[],
  candidates: ProcessCensusRow[],
  opts: {
    stillOwned?: () => Promise<boolean>;
    exclude?: (row: ProcessCensusRow) => boolean;
  } = {},
): Promise<ProcessReapResult | null> {
  const targets = new Map(
    candidates.filter((row) => !opts.exclude?.(row)).map((row) => [row.pid, row] as const),
  );
  if (targets.size === 0) return null;
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of rows)
      if (!targets.has(row.pid) && targets.has(row.parent) && !opts.exclude?.(row)) {
        targets.set(row.pid, row);
        grew = true;
      }
  }
  if (opts.stillOwned && !(await opts.stillOwned())) return null;
  // A leader's group is signalled only when every member is ours.
  const wholeGroup = (row: ProcessCensusRow) =>
    row.group === Number(row.pid) &&
    rows.every((member) => member.group !== row.group || targets.has(member.pid));
  const lines = [...targets.values()]
    .map((row) => `${row.pid}|${wholeGroup(row) ? 1 : 0}|${row.identity}`)
    .join('\n');
  const reap = await execOnSlot(
    vars,
    [
      ': farmslot-owned-process-reap',
      `targets='${lines}'`,
      `expected=$(printf '%s\\n' "$targets" | cut -d'|' -f1,3)`,
      `groups=" $(printf '%s\\n' "$targets" | awk -F'|' '$2 == 1 { print $1 }' | tr '\\n' ' ')"`,
      `pids=$(printf '%s\\n' "$targets" | cut -d'|' -f1 | paste -sd, -)`,
      // One ps per check. Only a pid whose start time still matches the census
      // is live, so a reused pid is never signalled.
      `live() { ps -o pid=,lstart= -p "$pids" 2>/dev/null | awk '{ pid = $1; $1 = ""; sub(/^ +/, ""); print pid "|" $0 }' | grep -Fx -- "$expected" | cut -d'|' -f1; }`,
      `sig() { for pid in $(live); do case "$groups" in *" $pid "*) kill -"$1" -- "-$pid" 2>/dev/null || kill -"$1" "$pid" 2>/dev/null ;; *) kill -"$1" "$pid" 2>/dev/null ;; esac; done; return 0; }`,
      'wait_gone() { end=$((SECONDS + $1)); while [ "$SECONDS" -lt "$end" ] && [ -n "$(live)" ]; do sleep 0.2; done; }',
      'sig TERM',
      'wait_gone 8',
      'sig KILL',
      'wait_gone 3',
      `live | sed 's/^/survivor /'`,
    ].join('\n'),
    { cwd: '/', timeout: 30_000 },
  );
  if (reap.exitCode !== 0)
    throw new Error(
      `Slot process cleanup failed: ${reap.stderr.trim() || `exit ${reap.exitCode}`}`,
    );
  const survivors = reap.stdout
    .split('\n')
    .flatMap((line) => (line.startsWith('survivor ') ? [line.slice(9).trim()] : []));
  return {
    total: targets.size,
    survivors: survivors.flatMap((pid) => {
      const row = targets.get(pid);
      return row ? [row] : [];
    }),
  };
}
