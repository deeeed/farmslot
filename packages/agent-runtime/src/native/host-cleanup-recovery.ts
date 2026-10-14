import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readNativeProcessSnapshot } from './process-tree.js';
import { alive, durableWrite, privateDirectory, processGroupAlive, readJson } from './storage.js';

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
    !Array.isArray(cleanup.observedProcesses) ||
    !cleanup.observedProcesses.length
  )
    throw new Error('Native cleanup recovery requires matching recorded host evidence');
  const pids = new Set([supervisorPid, hostPid]);
  const groups = new Set([supervisorPid]);
  const observe = (entry: unknown) => {
    if (
      !object(entry) ||
      !pid(entry.pid) ||
      !pid(entry.parent) ||
      !pid(entry.group) ||
      typeof entry.identity !== 'string' ||
      !entry.identity.trim()
    )
      throw new Error('Native cleanup recovery has malformed process evidence');
    pids.add(entry.pid);
    groups.add(entry.group);
    return entry;
  };
  let hostObserved = false;
  for (const entry of cleanup.observedProcesses) {
    const observed = observe(entry);
    if (observed.pid === hostPid && observed.parent === supervisorPid) hostObserved = true;
  }
  if (!hostObserved) throw new Error('Native cleanup recovery cannot identify the old host');
  const journals: Record<string, string> = {};
  const sessionRoot = join(root, 'sessions');
  for (const name of readdirSync(sessionRoot).filter((name) => name.endsWith('.journal'))) {
    const bytes = privateBytes(join(sessionRoot, name));
    if (!bytes.length || bytes.at(-1) !== 10)
      throw new Error('Native cleanup recovery refuses an incomplete session journal');
    let info: Record<string, unknown> | undefined;
    for (const line of bytes.toString().split('\n').filter(Boolean)) {
      const entry: unknown = JSON.parse(line);
      if (!object(entry)) throw new Error('Native cleanup recovery has malformed session evidence');
      if (entry.info !== undefined) {
        if (!object(entry.info))
          throw new Error('Native cleanup recovery has malformed session identity');
        info = entry.info;
      }
      // Include detached descendants retained in journals, not only runner leaders.
      for (const key of ['processes', 'processesAdded']) {
        if (entry[key] === undefined) continue;
        if (!Array.isArray(entry[key]))
          throw new Error('Native cleanup recovery has malformed process evidence');
        for (const observed of entry[key]) observe(observed);
      }
    }
    if (!info || !['closed', 'failed'].includes(String(info.state)) || info.processStopped !== true)
      throw new Error('Native cleanup recovery requires terminal, confirmed-stopped sessions');
    if (info.processPid !== undefined) {
      if (!pid(info.processPid))
        throw new Error('Native cleanup recovery has malformed runner identity');
      pids.add(info.processPid);
      groups.add(info.processPid);
    }
    journals[name] = digest(bytes);
  }
  const snapshot = readNativeProcessSnapshot();
  if (!snapshot.has(process.pid))
    throw new Error('Native cleanup recovery process census is incomplete');
  for (const entry of snapshot.values()) {
    if (pids.has(entry.pid) || groups.has(entry.group))
      throw new Error('Native cleanup recovery found a surviving process or group');
  }
  // Recheck absence independently after the census. Permission denial is still alive.
  for (const value of pids)
    if (alive(value))
      throw new Error('Native cleanup recovery cannot confirm a recorded process stopped');
  for (const value of groups)
    if (processGroupAlive(value))
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
  const history = join(root, 'cleanup-recoveries');
  privateDirectory(history);
  const receipt = `${randomUUID()}.json`;
  durableWrite(join(history, receipt), {
    schemaVersion: 1,
    verifiedAt: new Date().toISOString(),
    supervisorPid,
    hostPid,
    originalCleanup: cleanup,
    originalCleanupSha256: digest(original),
    journalSha256: journals,
    verifiedAbsentPids: [...pids],
    verifiedEmptyGroups: [...groups],
  });
  durableWrite(cleanupPath, {
    ...cleanup,
    state: 'complete',
    recoveryReceipt: `cleanup-recoveries/${receipt}`,
  });
}
