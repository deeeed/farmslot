import { execOnSlot, type SlotVars } from '../core/index.js';
import { shellQuote } from '../core/tmux.js';

import {
  isTmuxProcess,
  isWithinPath,
  parseLsofNames,
  parseProcessCensus,
  type ProcessCensusRow,
} from './process-census.js';

const CENSUS_MARKER = 'farmslot-browser-session-census';
const REAP_MARKER = 'farmslot-browser-session-reap';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Stop the browser session a run left on its slot: the browser on the slot's
 * CDP port and the helpers attached to it (wallet host, console collector).
 * A recipe call starts them detached, so they outlive the worker with parent 1
 * and no lease records them (run 22e62daa). A process is reaped only when it is
 * detached, on the CDP port (socket or flag) and tied to the slot checkout by
 * its working directory or arguments; descendants go with it. While a
 * capability lease on the slot still holds or keeps providers warm, its release
 * effect decides and nothing is reaped; a process a lease recorded is never
 * reaped. Returns a reason naming each process that survived SIGKILL.
 */
export async function reapSlotBrowserSession(
  vars: SlotVars,
  opts: { stillOwned?: () => Promise<boolean> } = {},
): Promise<string | null> {
  const cdpPort = vars.resourceVars?.cdp_port;
  if (!cdpPort || !/^\d+$/.test(cdpPort) || !vars.remoteRepo) return null;
  const census = await execOnSlot(
    vars,
    [
      `: ${CENSUS_MARKER}`,
      'ps -axo pid=,ppid=,pgid=,lstart=,args= || exit 3',
      `echo "--repo-- $(cd ${shellQuote(vars.remoteRepo)} 2>/dev/null && pwd -P)"`,
      `pids=$(lsof -nP -iTCP:${cdpPort} -t 2>/dev/null | sort -u | paste -sd, -)`,
      'echo "--cdp-- $pids"',
      'if [ -n "$pids" ]; then lsof -a -d cwd -Fpn -p "$pids" 2>/dev/null; fi',
      'true',
    ].join('\n'),
    { cwd: '/', timeout: 15_000 },
  );
  if (census.exitCode !== 0)
    return 'Browser session process census is unavailable; slot teardown was skipped';
  const [table, after = ''] = census.stdout.split(/^--repo-- /m);
  const [realRepo = '', cdpLine = '', ...cwdLines] = after.split('\n');
  const onPort = new Set(
    cdpLine
      .replace(/^--cdp-- /, '')
      .split(',')
      .filter(Boolean),
  );
  const rows = parseProcessCensus(table);
  const cwds = new Map(parseLsofNames(cwdLines.join('\n')));
  const repos = [
    ...new Set([vars.remoteRepo, realRepo].filter(Boolean).map((repo) => repo.replace(/\/$/, ''))),
  ];
  const repoArg = new RegExp(
    `(?:^|[\\s='"])(?:${repos.map(escapeRegExp).join('|')})(?=$|[\\s/'"])`,
  );
  const portArg = new RegExp(
    `(?:^|\\s)--(?:cdp-port|remote-debugging-port)(?:=|\\s+)${cdpPort}(?=$|\\s)`,
  );
  const candidates = rows.filter((row) => {
    const cwd = cwds.get(row.pid);
    return (
      row.parent === '1' &&
      !isTmuxProcess(row.command) &&
      (onPort.has(row.pid) || portArg.test(row.command)) &&
      ((cwd !== undefined && repos.some((repo) => isWithinPath(repo, cwd))) ||
        repoArg.test(row.command))
    );
  });
  if (candidates.length === 0) return null;
  const { getRuntimeCapabilityRegistry } = await import('../methods/runtime-capabilities.js');
  const { leases } = await getRuntimeCapabilityRegistry().settledStatus(vars.slotId);
  if (
    leases.some(
      (lease) => lease.state === 'acquired' || lease.keepWarmUntil || lease.providerCleanupDeferred,
    )
  )
    return null;
  const frames = leases.flatMap((lease) => lease.providerProcesses ?? []);
  const exempt = (row: ProcessCensusRow) =>
    frames.some(
      (frame) =>
        (String(frame.pid) === row.pid && frame.identity === row.identity) ||
        frame.group === row.group,
    );
  const targets = new Map(
    candidates.filter((row) => !exempt(row)).map((row) => [row.pid, row] as const),
  );
  if (targets.size === 0) return null;
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of rows)
      if (!targets.has(row.pid) && targets.has(row.parent) && !exempt(row)) {
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
      `: ${REAP_MARKER}`,
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
    return `Browser session cleanup failed: ${reap.stderr.trim() || `exit ${reap.exitCode}`}`;
  const survivors = reap.stdout
    .split('\n')
    .flatMap((line) => (line.startsWith('survivor ') ? [line.slice(9).trim()] : []));
  console.log(
    `[browser-session] ${vars.slotId}: stopped ${targets.size - survivors.length} browser session process(es) on CDP port ${cdpPort}`,
  );
  if (survivors.length === 0) return null;
  return survivors
    .map((pid) => {
      const args = targets.get(pid)?.command ?? '';
      return `Browser session process ${pid} (${args.length > 120 ? `${args.slice(0, 117)}...` : args}) on CDP port ${cdpPort} did not stop`;
    })
    .join('; ');
}
