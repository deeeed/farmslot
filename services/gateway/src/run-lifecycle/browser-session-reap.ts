import path from 'node:path';

import { execOnSlot, type SlotVars } from '../core/index.js';
import { shellQuote } from '../core/tmux.js';

import {
  isTmuxProcess,
  isWithinPath,
  parseLsofNames,
  parseProcessCensus,
  type ProcessCensusRow,
} from './process-census.js';
import { reapIdentifiedSlotProcesses } from './process-reap.js';

const CENSUS_MARKER = 'farmslot-browser-session-census';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Stop the browser session a run left on its slot: the browser on the slot's
 * CDP port and the helpers attached to it (wallet host, console collector).
 * A recipe call starts them detached, so they outlive the worker with parent 1
 * and no lease records them (run 22e62daa). A process is reaped only when it is
 * detached and either uses a browser profile inside the slot checkout, or is
 * on its CDP port and tied to the checkout by cwd or arguments. Descendants
 * go with it. While a capability lease on the slot still holds or keeps providers warm, its release
 * effect decides and nothing is reaped; a process a lease recorded is never
 * reaped. Returns a reason naming each process that survived SIGKILL.
 */
export async function reapSlotBrowserSession(
  vars: SlotVars,
  opts: { stillOwned?: () => Promise<boolean> } = {},
): Promise<string | null> {
  const configuredPort = vars.resourceVars?.cdp_port;
  const cdpPort = configuredPort && /^\d+$/.test(configuredPort) ? configuredPort : undefined;
  if (!vars.remoteRepo) return null;
  const census = await execOnSlot(
    vars,
    [
      `: ${CENSUS_MARKER}`,
      'ps -axo pid=,ppid=,pgid=,lstart=,args= || exit 3',
      `echo "--repo-- $(cd ${shellQuote(vars.remoteRepo)} 2>/dev/null && pwd -P)"`,
      cdpPort
        ? `pids=$(lsof -nP -iTCP:${cdpPort} -t 2>/dev/null | sort -u | paste -sd, -)`
        : "pids=''",
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
  const portArg = cdpPort
    ? new RegExp(`(?:^|\\s)--(?:cdp-port|remote-debugging-port)(?:=|\\s+)${cdpPort}(?=$|\\s)`)
    : undefined;
  const candidates = rows.filter((row) => {
    const cwd = cwds.get(row.pid);
    const profileArg = /(?:^|\s)--user-data-dir(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(
      row.command,
    );
    const profile = profileArg?.[1] ?? profileArg?.[2] ?? profileArg?.[3];
    const ownedProfile =
      profile !== undefined &&
      path.posix.isAbsolute(profile) &&
      repos.some((repo) => isWithinPath(repo, path.posix.normalize(profile)));
    return (
      row.parent === '1' &&
      !isTmuxProcess(row.command) &&
      (ownedProfile ||
        ((onPort.has(row.pid) || portArg?.test(row.command)) &&
          ((cwd !== undefined && repos.some((repo) => isWithinPath(repo, cwd))) ||
            repoArg.test(row.command))))
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
  const result = await reapIdentifiedSlotProcesses(vars, rows, candidates, {
    ...opts,
    exclude: exempt,
  });
  if (!result) return null;
  const { survivors, total } = result;
  console.log(
    `[browser-session] ${vars.slotId}: stopped ${total - survivors.length} browser session process(es)`,
  );
  if (survivors.length === 0) return null;
  return survivors
    .map(({ pid, command: args }) => {
      const scope =
        onPort.has(pid) || portArg?.test(args)
          ? `on CDP port ${cdpPort}`
          : 'with a profile in the slot repository';
      return `Browser session process ${pid} (${args.length > 120 ? `${args.slice(0, 117)}...` : args}) ${scope} did not stop`;
    })
    .join('; ');
}
