import type { RuntimeCapabilityLease } from '@farmslot/protocol';

import { execOnSlot, type SlotVars } from '../core/index.js';
import { shellQuote } from '../core/tmux.js';

type ProviderFrame = NonNullable<RuntimeCapabilityLease['providerProcesses']>[number];

interface CensusRow {
  pid: number;
  parent: number;
  group: number;
  identity: string;
  args: string;
}

const CENSUS_MARKER = 'farmslot-browser-session-census';
const REAP_MARKER = 'farmslot-browser-session-reap';

/** Every process a capability lease recorded on this slot; its release effect decides, not us. */
async function slotLeaseProviderFrames(slotId: string): Promise<ProviderFrame[]> {
  const { getRuntimeCapabilityRegistry } = await import('../methods/runtime-capabilities.js');
  const status = await getRuntimeCapabilityRegistry().settledStatus(slotId);
  return status.leases.flatMap((lease) => lease.providerProcesses ?? []);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Stop the browser session a run left on its slot: the browser on the slot's
 * CDP port and the helpers attached to it (wallet host, console collector).
 * A recipe call starts them detached, so they outlive the worker with parent 1
 * and no lease records them (run 22e62daa). A process is reaped only when it is
 * detached, on the CDP port (socket or flag) and tied to the slot checkout by
 * its working directory or arguments; descendants go with it. Lease providers
 * are exempt. Returns a reason naming each process that survived SIGKILL.
 */
export async function reapSlotBrowserSession(
  vars: SlotVars,
  opts: { stillOwned?: () => Promise<boolean> } = {},
): Promise<string | null> {
  const cdpPort = vars.resourceVars?.cdp_port;
  if (!cdpPort || !/^\d+$/.test(cdpPort)) return null;
  const census = await execOnSlot(
    vars,
    [
      `: ${CENSUS_MARKER}`,
      'ps -axo pid=,ppid=,pgid=,lstart=,args=',
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
      .filter(Boolean)
      .map(Number),
  );
  const rows: CensusRow[] = table.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.*)$/.exec(line);
    return match
      ? [
          {
            pid: Number(match[1]),
            parent: Number(match[2]),
            group: Number(match[3]),
            identity: match[4].replace(/\s+/g, ' '),
            args: match[5],
          },
        ]
      : [];
  });
  const cwds = new Map<number, string>();
  let cwdPid = 0;
  for (const line of cwdLines) {
    if (line.startsWith('p')) cwdPid = Number(line.slice(1));
    if (line.startsWith('n')) cwds.set(cwdPid, line.slice(1));
  }
  const repos = [
    ...new Set([vars.remoteRepo, realRepo].filter(Boolean).map((repo) => repo.replace(/\/$/, ''))),
  ];
  const inRepo = (file: string | undefined) =>
    !!file && repos.some((repo) => file === repo || file.startsWith(`${repo}/`));
  const repoArg = new RegExp(
    `(?:^|[\\s='"])(?:${repos.map(escapeRegExp).join('|')})(?=$|[\\s/'"])`,
  );
  const portArg = new RegExp(
    `(?:^|\\s)--(?:cdp-port|remote-debugging-port)(?:=|\\s+)${cdpPort}(?=$|\\s)`,
  );
  const candidates = rows.filter(
    (row) =>
      row.parent === 1 &&
      (onPort.has(row.pid) || portArg.test(row.args)) &&
      (inRepo(cwds.get(row.pid)) || repoArg.test(row.args)),
  );
  if (candidates.length === 0) return null;
  const frames = await slotLeaseProviderFrames(vars.slotId);
  const exempt = (row: CensusRow) =>
    frames.some(
      (frame) =>
        (frame.pid === row.pid && frame.identity === row.identity) || frame.group === row.group,
    );
  const roots = candidates.filter((row) => !exempt(row));
  if (roots.length === 0) return null;
  const targets = new Map(roots.map((row) => [row.pid, row]));
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
  const wholeGroup = (row: CensusRow) =>
    row.group === row.pid &&
    rows.every((member) => member.group !== row.group || targets.has(member.pid));
  const lines = [...targets.values()]
    .map((row) => `${row.pid}|${wholeGroup(row) ? 1 : 0}|${row.identity}`)
    .join('\n');
  const reap = await execOnSlot(
    vars,
    [
      `: ${REAP_MARKER}`,
      `targets='${lines}'`,
      // Signals only a pid whose start time still matches the census, so a
      // reused pid is never touched.
      `alive() { [ "$(ps -o lstart= -p "$1" 2>/dev/null | awk '{$1=$1};1')" = "$2" ]; }`,
      'each() { printf \'%s\\n\' "$targets" | while IFS=\'|\' read -r pid group identity; do "$@" "$pid" "$group" "$identity"; done; }',
      'sig() { alive "$2" "$4" || return 0; if [ "$3" = 1 ]; then kill -"$1" -- "-$2" 2>/dev/null || kill -"$1" "$2" 2>/dev/null; else kill -"$1" "$2" 2>/dev/null; fi; return 0; }',
      'live() { if alive "$1" "$3"; then echo "$1"; fi; return 0; }',
      'wait_gone() { i=0; while [ "$i" -lt "$1" ] && [ -n "$(each live)" ]; do sleep 0.2; i=$((i+1)); done; }',
      'each sig TERM',
      'wait_gone 40',
      'each sig KILL',
      'wait_gone 15',
      'each live | sed "s/^/survivor /"',
    ].join('\n'),
    { cwd: '/', timeout: 30_000 },
  );
  if (reap.exitCode !== 0)
    return `Browser session cleanup failed: ${reap.stderr.trim() || `exit ${reap.exitCode}`}`;
  const survivors = reap.stdout
    .split('\n')
    .flatMap((line) => (line.startsWith('survivor ') ? [Number(line.slice(9))] : []));
  console.log(
    `[browser-session] ${vars.slotId}: stopped ${targets.size - survivors.length} browser session process(es) on CDP port ${cdpPort}`,
  );
  if (survivors.length === 0) return null;
  return survivors
    .map((pid) => {
      const args = targets.get(pid)?.args ?? '';
      return `Browser session process ${pid} (${args.length > 120 ? `${args.slice(0, 117)}...` : args}) on CDP port ${cdpPort} did not stop`;
    })
    .join('; ');
}
