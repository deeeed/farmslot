import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  journalProcesses,
  type ProcessIdentity,
  type ProcessJournalEntry,
  readNativeProcessSnapshot,
} from './process-tree.js';
import {
  alive,
  durableWrite,
  privateDirectory,
  processIdentityAlive,
  readJson,
  recordedProcessGroupAlive,
} from './storage.js';

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function pid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function privateBytes(file: string): Buffer {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw new Error('Native cleanup recovery requires private, owned regular files');
  return readFileSync(file);
}
function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function processEvidence(entry: unknown): ProcessIdentity {
  if (
    !object(entry) ||
    !pid(entry.pid) ||
    !pid(entry.parent) ||
    !pid(entry.group) ||
    typeof entry.identity !== 'string' ||
    !entry.identity.trim()
  )
    throw new Error('Native cleanup recovery has malformed process evidence');
  return { pid: entry.pid, parent: entry.parent, group: entry.group, identity: entry.identity };
}

/** Called only by the supervisor while holding its exclusive startup claim. */
export function recoverStoppedNativeHost(
  root: string,
  supervisorPid: number,
  hostPid: number,
): void {
  const cleanupPath = join(root, 'cleanup.json');
  const original = privateBytes(cleanupPath);
  const cleanup: unknown = JSON.parse(original.toString());
  if (
    !pid(supervisorPid) ||
    !pid(hostPid) ||
    !object(cleanup) ||
    cleanup.hostPid !== hostPid ||
    !['pending', 'unknown'].includes(String(cleanup.state)) ||
    (cleanup.observedProcesses !== undefined && !Array.isArray(cleanup.observedProcesses))
  )
    throw new Error('Native cleanup recovery requires matching recorded host evidence');
  const pids = new Set([supervisorPid, hostPid]);
  const groups = new Set([supervisorPid]);
  const identities = new Map<number, string>();
  const observe = (entry: ProcessIdentity) => {
    pids.add(entry.pid);
    groups.add(entry.group);
    identities.set(entry.pid, entry.identity);
    return entry;
  };
  let hostObserved = false;
  const observations = Array.isArray(cleanup.observedProcesses) ? cleanup.observedProcesses : [];
  for (const entry of observations) {
    const observed = observe(processEvidence(entry));
    if (observed.pid === hostPid && observed.parent === supervisorPid) hostObserved = true;
  }
  if (!hostObserved && observations.length)
    throw new Error('Native cleanup recovery cannot identify the old host');
  const journals: Record<string, string> = {};
  let unattributedSession = false;
  let hostObservationJournal: string | undefined;
  const sessionRoot = join(root, 'sessions');
  for (const name of readdirSync(sessionRoot).filter((name) => name.endsWith('.journal'))) {
    const bytes = privateBytes(join(sessionRoot, name));
    if (!bytes.length || bytes.at(-1) !== 10)
      throw new Error('Native cleanup recovery refuses an incomplete session journal');
    let info: Record<string, unknown> | undefined;
    const entries: ProcessJournalEntry[] = [];
    for (const line of bytes.toString().split('\n').filter(Boolean)) {
      const entry: unknown = JSON.parse(line);
      if (!object(entry)) throw new Error('Native cleanup recovery has malformed session evidence');
      const projected: ProcessJournalEntry = {};
      if (entry.info !== undefined) {
        if (!object(entry.info) || typeof entry.info.generation !== 'string')
          throw new Error('Native cleanup recovery has malformed session identity');
        if (!hostObserved && (!pid(entry.info.hostPid) || entry.info.hostPid === hostPid))
          unattributedSession = true;
        info = entry.info;
        projected.info = { generation: entry.info.generation };
      }
      // Include detached descendants retained in journals, not only runner leaders.
      for (const key of ['processes', 'processesAdded'] as const) {
        if (entry[key] === undefined) continue;
        if (!Array.isArray(entry[key]))
          throw new Error('Native cleanup recovery has malformed process evidence');
        projected[key] = entry[key].map(processEvidence);
      }
      entries.push(projected);
    }
    if (!info || !['closed', 'failed'].includes(String(info.state)) || info.processStopped !== true)
      throw new Error('Native cleanup recovery requires terminal, confirmed-stopped sessions');
    if (info.hostPid === hostPid && info.processPid !== undefined) {
      if (!pid(info.processPid))
        throw new Error('Native cleanup recovery has malformed runner identity');
      pids.add(info.processPid);
      groups.add(info.processPid);
      const processes = journalProcesses(entries) ?? [];
      // This kernel-recorded parent link attests that the host was released.
      // Fresh absence checks below still cover every recorded process and group.
      if (
        !hostObserved &&
        processes.some((entry) => entry.pid === info.processPid && entry.parent === hostPid)
      )
        hostObservationJournal ??= name;
      for (const observed of processes) observe(observed);
    }
    journals[name] = digest(bytes);
  }
  if (hostObservationJournal) hostObserved = true;
  if (!hostObserved && unattributedSession)
    throw new Error('Unobserved native host recovery cannot exclude a session from that host');
  const snapshot = readNativeProcessSnapshot();
  if (!snapshot.has(process.pid))
    throw new Error('Native cleanup recovery process census is incomplete');
  for (const value of pids) {
    const entry = snapshot.get(value);
    const identity = identities.get(value);
    if (entry && (!identity || entry.identity.trim() === identity.trim()))
      throw new Error('Native cleanup recovery found a surviving process or group');
  }
  for (const value of groups)
    if (recordedProcessGroupAlive(value, identities.get(value), snapshot))
      throw new Error('Native cleanup recovery found a surviving process or group');
  // Recheck absence independently after the census. Permission denial is still alive.
  for (const value of pids)
    if (identities.has(value) ? processIdentityAlive(value, identities.get(value)!) : alive(value))
      throw new Error('Native cleanup recovery cannot confirm a recorded process stopped');
  for (const value of groups)
    if (recordedProcessGroupAlive(value, identities.get(value)))
      throw new Error('Native cleanup recovery cannot confirm a recorded group stopped');
  if (
    !privateBytes(cleanupPath).equals(original) ||
    readJson<{ pid: number }>(join(root, 'lock', 'owner.json')).pid !== supervisorPid ||
    readJson<{ pid: number }>(join(root, 'worker.json')).pid !== hostPid
  )
    throw new Error('Native cleanup ownership changed during recovery');
  for (const [name, hash] of Object.entries(journals))
    if (digest(privateBytes(join(sessionRoot, name))) !== hash)
      throw new Error('Native session journal changed during cleanup recovery');
  const historyName = hostObserved ? 'cleanup-recoveries' : 'cleanup-quarantine';
  const history = join(root, historyName);
  privateDirectory(history);
  const receipt = `${randomUUID()}.json`;
  durableWrite(join(history, receipt), {
    schemaVersion: 1,
    quarantined: !hostObserved,
    ...(!hostObserved ? { originalCleanupBytesBase64: original.toString('base64') } : {}),
    verifiedAt: new Date().toISOString(),
    supervisorPid,
    hostPid,
    originalCleanup: cleanup,
    ...(hostObservationJournal ? { hostObservationJournal } : {}),
    originalCleanupSha256: digest(original),
    journalSha256: journals,
    verifiedStoppedPids: [...pids],
    verifiedStoppedGroups: [...groups],
    recordedProcessIdentities: Object.fromEntries(identities),
  });
  durableWrite(cleanupPath, {
    ...cleanup,
    state: 'complete',
    recoveryReceipt: `${historyName}/${receipt}`,
  });
}
