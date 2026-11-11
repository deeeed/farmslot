import { execFile } from 'node:child_process';

import type { NodeTcpMetrics, NodeTcpSnapshot } from '../contracts/slots.js';

export type TcpCommandRunner = (command: string, args: readonly string[]) => Promise<string>;

// One kernel socket census per minute, shared by concurrent gauge/RPC reads.
const CADENCE_MS = 60_000;
const TIMEOUT_MS = 2_000;
const MAX_BYTES = 8 * 1024 * 1024;
const cache = new Map<string, { at: number; pending: Promise<NodeTcpMetrics> }>();

const runCommand: TcpCommandRunner = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: MAX_BYTES },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });

export function formatTcpSnapshotDetail(tcp: NodeTcpSnapshot): string {
  return `${tcp.total} connections (${tcp.established} ESTABLISHED + ${tcp.timeWait} TIME_WAIT), ephemeral range ${tcp.ephemeralCapacity}; top owners: ${tcp.topProcesses.map((owner) => `${owner.command} pid ${owner.pid}: ${owner.connections}`).join(', ') || 'unavailable'}`;
}

/** Counts are a conservative port-pressure signal, not unique occupied local ports. */
export function parseTcpMetrics(
  platform: 'darwin' | 'linux',
  range: string,
  sockets: string,
  processes = '',
): NodeTcpSnapshot {
  const ports = range.trim().split(/\s+/).map(Number);
  const [ephemeralFirst, ephemeralLast] = ports;
  if (
    ports.length !== 2 ||
    !ports.every((port) => Number.isInteger(port) && port > 0 && port <= 65535) ||
    ephemeralLast < ephemeralFirst
  )
    throw new Error('TCP ephemeral port range is unreadable');
  const names = new Map(
    processes.split('\n').flatMap((line) => {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      return match ? [[Number(match[1]), match[2].split('/').at(-1) ?? 'unknown'] as const] : [];
    }),
  );
  const owners = new Map<number, { pid: number; command: string; connections: number }>();
  let established = 0;
  let timeWait = 0;
  let pidColumn = -1;
  let headerFound = platform === 'linux';
  for (const line of sockets.split('\n')) {
    if (platform === 'darwin' && line.trim().startsWith('Proto ')) {
      pidColumn = line
        .replace(/Local Address|Foreign Address/g, 'Address')
        .trim()
        .split(/\s+/)
        .indexOf('pid');
      headerFound = pidColumn >= 0;
      continue;
    }
    const fields = line.trim().split(/\s+/);
    if (
      platform === 'linux' &&
      line.trim() &&
      (fields.length < 5 ||
        !/^[A-Z][A-Z0-9-]*$/.test(fields[0]) ||
        !/^\d+$/.test(fields[1]) ||
        !/^\d+$/.test(fields[2]))
    )
      throw new Error('TCP socket table is unreadable');
    const state = platform === 'darwin' ? fields[5] : fields[0];
    if (state === 'ESTABLISHED' || state === 'ESTAB') established++;
    else if (state === 'TIME_WAIT' || state === 'TIME-WAIT') timeWait++;
    else continue;
    const pids =
      platform === 'darwin'
        ? [Number(fields[pidColumn])]
        : [...new Set([...line.matchAll(/pid=(\d+)/g)].map((match) => Number(match[1])))];
    for (const pid of pids) {
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      const owner = owners.get(pid) ?? {
        pid,
        command:
          names.get(pid) ??
          (platform === 'linux' ? /\("([^"]+)"/.exec(line)?.[1] : undefined) ??
          'unknown',
        connections: 0,
      };
      owner.connections++;
      owners.set(pid, owner);
    }
  }
  if (!headerFound) throw new Error('TCP socket table is unreadable');
  const total = established + timeWait;
  const ephemeralCapacity = ephemeralLast - ephemeralFirst + 1;
  const warningThreshold = Math.ceil(ephemeralCapacity * 0.5);
  const criticalThreshold = Math.ceil(ephemeralCapacity * 0.8);
  return {
    established,
    timeWait,
    total,
    ephemeralFirst,
    ephemeralLast,
    ephemeralCapacity,
    warningThreshold,
    criticalThreshold,
    severity:
      total >= criticalThreshold ? 'critical' : total >= warningThreshold ? 'warning' : 'ok',
    topProcesses: [...owners.values()]
      .sort((a, b) => b.connections - a.connections || a.pid - b.pid)
      .slice(0, 5),
    collectedAt: new Date().toISOString(),
  };
}

export function collectTcpMetrics(
  platform = process.platform,
  runner: TcpCommandRunner = runCommand,
  now = Date.now(),
): Promise<NodeTcpMetrics> {
  const existing = cache.get(platform);
  if (existing && now - existing.at < CADENCE_MS) return existing.pending;
  const pending = (async (): Promise<NodeTcpMetrics> => {
    try {
      if (platform !== 'darwin' && platform !== 'linux')
        throw new Error('TCP metrics platform unsupported');
      const [range, sockets, processes] = await Promise.all(
        platform === 'darwin'
          ? [
              runner('/usr/sbin/sysctl', [
                '-n',
                'net.inet.ip.portrange.first',
                'net.inet.ip.portrange.last',
              ]),
              runner('/usr/sbin/netstat', ['-anv', '-p', 'tcp']),
              runner('/bin/ps', ['-axo', 'pid=,comm=']),
            ]
          : [
              runner('cat', ['/proc/sys/net/ipv4/ip_local_port_range']),
              runner('ss', ['-Htanp']),
              Promise.resolve(''),
            ],
      );
      return parseTcpMetrics(platform, range, sockets, processes);
    } catch (error) {
      // Missing tools, timeout and output overflow are unknown health, never a healthy zero.
      return {
        severity: 'unknown',
        error: (error instanceof Error ? error.message : String(error)).slice(0, 200),
        collectedAt: new Date().toISOString(),
      };
    }
  })();
  cache.set(platform, { at: now, pending });
  return pending;
}
