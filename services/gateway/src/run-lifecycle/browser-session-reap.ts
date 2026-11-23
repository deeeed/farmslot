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
 * detached and either uses a browser profile inside the slot checkout after
 * its workers are verified stopped (includeSlotProfiles), or is
 * on its CDP port and tied to the checkout by cwd or arguments. With the same
 * verification, a detached agent-browser daemon goes too when its session (the
 * `<session>.sock` it listens on) is this slot's (dispatch sets AGENT_BROWSER_SESSION
 * to the slot id), or is any named session other than 'default' and its cwd is in
 * the checkout: the cwd names the worker that started it and a named session is
 * not shared. Such daemons bind no CDP port and, left in the checkout, made every
 * later teardown skip the slot (four task sessions on macpro-mmt-5, 2026-11-20).
 * 'default' is the one session workers on other slots share: it is logged and
 * kept. Descendants
 * go with it. While a capability lease on the slot still holds or keeps providers warm, its release
 * effect decides and nothing is reaped; a process a lease recorded is never
 * reaped. Returns a reason naming each process that survived SIGKILL.
 */
export async function reapSlotBrowserSession(
  vars: SlotVars,
  opts: { stillOwned?: () => Promise<boolean>; includeSlotProfiles?: boolean } = {},
): Promise<string | null> {
  const configuredPort = vars.resourceVars?.cdp_port;
  const cdpPort = configuredPort && /^\d+$/.test(configuredPort) ? configuredPort : undefined;
  if (!vars.remoteRepo || (!cdpPort && !opts.includeSlotProfiles)) return null;
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
      // The executable as the kernel reports it (comm), not a whitespace-split argument.
      ...(opts.includeSlotProfiles
        ? [
            `ab=$(ps -axo pid=,comm= | sed -nE 's#^ *([0-9]+) +(.*/)?agent-browser(-[A-Za-z0-9_-]+)?$#\\1#p' | paste -sd, -)`,
            'echo "--agent-browser-- $ab"',
            'pids=$(printf \'%s,%s\' "$pids" "$ab" | tr , \'\\n\' | grep . | paste -sd, -)',
          ]
        : []),
      'if [ -n "$pids" ]; then lsof -a -d cwd -Fpn -p "$pids" 2>/dev/null; fi',
      // A daemon's session is the name of the socket it listens on.
      ...(opts.includeSlotProfiles
        ? [
            'echo "--agent-browser-sockets--"',
            'if [ -n "$ab" ]; then lsof -a -U -Fpn -p "$ab" 2>/dev/null; fi',
          ]
        : []),
      'true',
    ].join('\n'),
    { cwd: '/', timeout: 15_000 },
  );
  if (census.exitCode !== 0)
    return 'Browser session process census is unavailable; slot teardown was skipped';
  const [table, sections = ''] = census.stdout.split(/^--repo-- /m);
  const [after = '', sockets = ''] = sections.split(/^--agent-browser-sockets--$/m);
  const [realRepo = '', cdpLine = '', ...rest] = after.split('\n');
  const daemonLine = rest.find((line) => line.startsWith('--agent-browser-- ')) ?? '';
  const cwdLines = rest.filter((line) => line !== daemonLine);
  const agentBrowsers = new Set(
    daemonLine
      .replace(/^--agent-browser-- /, '')
      .split(',')
      .filter(Boolean),
  );
  const onPort = new Set(
    cdpLine
      .replace(/^--cdp-- /, '')
      .split(',')
      .filter(Boolean),
  );
  const sessions = new Map<string, string>();
  let socketPid = '';
  for (const line of sockets.split('\n')) {
    if (line.startsWith('p')) socketPid = line.slice(1);
    else if (line.startsWith('n/') && line.endsWith('.sock'))
      sessions.set(socketPid, path.posix.basename(line.slice(1), '.sock'));
  }
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
    const profile = /(?:^|\s)--user-data-dir(?:=|\s+)(\S+)/.exec(row.command)?.[1];
    const ownedProfile =
      opts.includeSlotProfiles &&
      profile !== undefined &&
      path.posix.isAbsolute(profile) &&
      repos.some((repo) => isWithinPath(repo, path.posix.normalize(profile)));
    const inRepo = cwd !== undefined && repos.some((repo) => isWithinPath(repo, cwd));
    const daemon = opts.includeSlotProfiles && agentBrowsers.has(row.pid);
    const session = sessions.get(row.pid);
    const slotDaemon =
      daemon &&
      (session === vars.slotId || (inRepo && session !== undefined && session !== 'default'));
    if (daemon && !slotDaemon && inRepo && row.parent === '1')
      console.log(
        `[browser-session] ${vars.slotId}: kept agent-browser daemon ${row.pid} in the checkout; its session ${session ?? 'unknown'} may be shared`,
      );
    return (
      row.parent === '1' &&
      !isTmuxProcess(row.command) &&
      (ownedProfile ||
        slotDaemon ||
        ((onPort.has(row.pid) || portArg?.test(row.command)) &&
          (inRepo || repoArg.test(row.command))))
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
          : agentBrowsers.has(pid)
            ? "of this slot's agent-browser session"
            : 'with a profile in the slot repository';
      return `Browser session process ${pid} (${args.length > 120 ? `${args.slice(0, 117)}...` : args}) ${scope} did not stop`;
    })
    .join('; ');
}
