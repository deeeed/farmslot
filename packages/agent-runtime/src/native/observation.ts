import { createHash, randomUUID } from 'node:crypto';
import { constants, existsSync, type FSWatcher, type Stats, watch } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { Methods, type NativeProfileStatusResult } from '@farmslot/protocol';

import { listNativeProfilesAsync, providerAccountsConfigPath } from './account-profiles.js';
import type { NativeSessionClient } from './client.js';
import type { HostIdentity } from './ipc.js';
import { routeNativeProfile } from './profile-service.js';
import { alive, readJsonAsync } from './storage.js';

/** Private node transport metadata. Never contains session IDs, paths or account data. */
export interface NativeSourceReceipt {
  version: 1;
  nodeId: string;
  ownerId: string;
  incarnation: string;
  revision: number;
  ready: boolean;
  error?: 'SOURCE_UNAVAILABLE';
  changed?: ('native-session' | 'profiles')[];
}

export class NativeSourceUnavailable extends Error {
  readonly code = 'NATIVE_SOURCE_UNAVAILABLE';
  constructor(readonly reason = 'source-not-ready') {
    super('Native observation source unavailable. Retry after source recovery.');
  }
}

export class NativeSourceChanged extends Error {
  readonly code = 'RESOURCE_OBSERVATION_CHANGED';
  constructor() {
    super('Native history changed during this read. Refreshing history.');
  }
}

/** A healthy advancing source supersedes a page; lost admission remains an error. */
export function assertNativeSourceCurrent(
  before: NativeSourceReceipt,
  after: NativeSourceReceipt,
  reason: 'node-read' | 'gateway-read' | 'remote-envelope',
): void {
  if (sameNativeSource(before, after)) return;
  if (
    before.ready &&
    after.ready &&
    before.nodeId === after.nodeId &&
    before.ownerId === after.ownerId &&
    before.incarnation === after.incarnation &&
    after.revision > before.revision
  ) {
    console.info(
      '[native-observation]',
      JSON.stringify({
        code: 'RESOURCE_OBSERVATION_CHANGED',
        reason,
        nodeId: after.nodeId,
        beforeRevision: before.revision,
        afterRevision: after.revision,
      }),
    );
    throw new NativeSourceChanged();
  }
  const unavailable = new NativeSourceUnavailable(`${reason}-source-replaced-or-unavailable`);
  console.warn(
    '[native-observation]',
    JSON.stringify({ code: unavailable.code, reason: unavailable.reason, nodeId: after.nodeId }),
  );
  throw unavailable;
}

interface SourceSnapshot {
  digest: string;
  host: string;
  accounts: string;
}

/** One process owner per host. Observes durable journal commits, including other processes. */
export class NativeHostObservation {
  private watchers: FSWatcher[] = [];
  private receipt: NativeSourceReceipt;
  private snapshot?: SourceSnapshot;
  private accountDigest = '';
  /** False while the last profile sample failed: sessions stay observable, profile reads don't. */
  private accountsAvailable = false;
  private readonly profileStatuses = new Map<string, NativeProfileStatusResult>();
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private stopped = true;
  private refreshing = false;
  private queued = false;
  private changes = 0;
  private failed = false;
  private recovering?: Promise<void>;
  private arming = false;
  private retrying?: Promise<void>;
  private scanTail: Promise<unknown> = Promise.resolve();
  private queuedScan?: Promise<SourceSnapshot>;
  private queuedScanGeneration = -1;
  private readonly journals = new Map<string, { stamp: string; digest: string }>();

  constructor(
    private readonly client: NativeSessionClient,
    ownerId: string,
    private readonly publish: (receipt: NativeSourceReceipt) => void,
    private readonly home?: string,
    private readonly observeAccounts: () => Promise<NativeProfileStatusResult[]> = async () => {
      const statuses: NativeProfileStatusResult[] = [];
      for (const profile of await listNativeProfilesAsync(home)) {
        if (profile.state === 'active')
          statuses.push(
            (await routeNativeProfile(client, ownerId, Methods.NATIVE_PROFILE_STATUS, {
              profileId: profile.id,
            })) as NativeProfileStatusResult,
          );
      }
      return statuses;
    },
  ) {
    this.receipt = {
      version: 1,
      nodeId: client.executionNodeId,
      ownerId,
      incarnation: randomUUID(),
      revision: 0,
      ready: false,
      error: 'SOURCE_UNAVAILABLE',
    };
  }

  current(): NativeSourceReceipt {
    return { ...this.receipt };
  }

  /** Arming is independent of RPC completion and never starts the detached host. */
  async start(): Promise<void> {
    this.stop();
    this.stopped = false;
    this.failed = false;
    this.arming = true;
    const generation = this.generation;
    try {
      this.arm();
      const before = await this.scan();
      if (generation !== this.generation || this.stopped) return;
      const change = this.changes;
      // A failed profile sample affects only profile reads (ADR-057 Amendment 11).
      const accounts = await this.observeAccounts().catch((error: unknown) =>
        this.sampleFailed(error),
      );
      if (generation !== this.generation || this.stopped) return;
      const after = await this.scan();
      if (generation !== this.generation || this.stopped) return;
      if (this.failed) throw new NativeSourceUnavailable('arming-source-changed');
      if (change !== this.changes || before.digest !== after.digest)
        throw new NativeSourceUnavailable('arming-source-changed');
      this.setAccounts(accounts);
      this.snapshot = after;
      this.receipt = {
        ...this.receipt,
        incarnation: randomUUID(),
        revision: 0,
        ready: true,
        error: undefined,
        changed: ['native-session', 'profiles'],
      };
      this.publish(this.current());
    } catch (error) {
      if (generation !== this.generation || this.stopped) return;
      this.fail(error instanceof NativeSourceUnavailable ? error.reason : 'arming-failed');
      if (error instanceof NativeSourceUnavailable) throw error;
      throw new NativeSourceUnavailable('arming-failed');
    } finally {
      if (generation === this.generation) {
        this.arming = false;
        if (!this.stopped) this.scheduleAccounts();
      }
    }
  }

  /** Explicit source Retry. All observers share the same arming attempt, never a command. */
  retry(): Promise<void> {
    if (this.retrying) return this.retrying;
    this.retrying = this.start().finally(() => {
      this.retrying = undefined;
    });
    return this.retrying;
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    if (this.receipt.ready) this.fail('source-stopped');
  }

  /** Fresh scans close the fs.watch delivery window without blocking other RPCs. */
  async fence(): Promise<NativeSourceReceipt> {
    if (!this.receipt.ready || this.stopped)
      throw new NativeSourceUnavailable(this.stopped ? 'source-stopped' : 'source-not-ready');
    const generation = this.generation;
    try {
      const current = await this.scan();
      if (generation !== this.generation || this.stopped)
        throw new NativeSourceUnavailable('source-stopped');
      if (!this.receipt.ready) throw new NativeSourceUnavailable('source-not-ready');
      if (current.host !== this.snapshot?.host || current.accounts !== this.snapshot?.accounts) {
        throw new NativeSourceUnavailable(
          current.host !== this.snapshot?.host ? 'host-changed' : 'profiles-changed',
        );
      }
      if (current.digest !== this.snapshot?.digest) {
        this.snapshot = current;
        this.advance(['native-session']);
      }
      return this.current();
    } catch (error) {
      if (generation === this.generation) {
        this.fail(error instanceof NativeSourceUnavailable ? error.reason : 'scan-failed');
        // A fence can see a registration change before its watcher delivers it.
        if (
          error instanceof NativeSourceUnavailable &&
          (error.reason === 'host-changed' || error.reason === 'profiles-changed')
        )
          this.recover();
      }
      if (error instanceof NativeSourceUnavailable) throw error;
      throw new NativeSourceUnavailable('scan-failed');
    }
  }

  async read<T>(read: () => Promise<T>): Promise<{ value: T; nativeSource: NativeSourceReceipt }> {
    const before = await this.fence();
    let value!: T;
    let failure: unknown;
    let rejected = false;
    try {
      value = await read();
    } catch (error) {
      rejected = true;
      failure = error;
    }
    const after = await this.fence();
    assertNativeSourceCurrent(before, after, 'node-read');
    if (rejected) throw failure;
    return { value, nativeSource: before };
  }

  /** Marked profile reads consume the one shared structured account sample, with its original age.
   * Imperative profile/status retains its existing on-demand probe outside this source. */
  async profileStatus(profileId: string): Promise<NativeProfileStatusResult> {
    await this.fence();
    if (!this.accountsAvailable)
      throw Object.assign(
        new Error(
          'Native account profiles are unavailable on this node. Retry after its next sample.',
        ),
        { code: 'NATIVE_PROFILES_UNAVAILABLE' },
      );
    const status = this.profileStatuses.get(profileId);
    if (!status)
      throw Object.assign(new Error('Native account profile is unavailable'), {
        code: 'NOT_FOUND',
      });
    return structuredClone(status);
  }
  private setAccounts(accounts: NativeProfileStatusResult[] | undefined): void {
    this.profileStatuses.clear();
    for (const status of accounts ?? [])
      this.profileStatuses.set(status.profile.id, structuredClone(status));
    this.accountsAvailable = accounts !== undefined;
    this.accountDigest = accountsDigest(accounts);
  }

  /** Logs a failed profile sample once per outage; sessions stay observable. */
  private sampleFailed(error: unknown): undefined {
    if (this.accountsAvailable || !this.receipt.ready)
      console.warn(
        '[native-observation]',
        JSON.stringify({
          code: 'NATIVE_PROFILES_UNAVAILABLE',
          reason: error instanceof Error ? error.message : String(error),
          nodeId: this.client.executionNodeId,
        }),
      );
    return undefined;
  }
  private fail(reason: string): void {
    if (!this.failed)
      console.warn(
        '[native-observation]',
        JSON.stringify({
          code: 'NATIVE_SOURCE_UNAVAILABLE',
          reason,
          nodeId: this.client.executionNodeId,
        }),
      );
    this.failed = true;
    this.receipt = {
      ...this.receipt,
      ready: false,
      error: 'SOURCE_UNAVAILABLE',
      revision: this.receipt.revision + 1,
      changed: ['native-session', 'profiles'],
    };
    this.publish(this.current());
  }
  private advance(
    changed: ('native-session' | 'profiles')[] = ['native-session', 'profiles'],
  ): void {
    this.receipt = { ...this.receipt, revision: this.receipt.revision + 1, changed };
    this.publish(this.current());
  }
  private arm(): void {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    const targets = new Map<string, boolean>();
    const root = nearestDirectory(this.client.root);
    targets.set(root, root === this.client.root);
    const configParent = nearestDirectory(dirname(providerAccountsConfigPath(this.home)));
    targets.set(configParent, targets.get(configParent) ?? false);

    for (const [path, recursive] of targets) {
      const watcher = watch(path, { recursive }, () => void this.changed());
      watcher.on('error', () => {
        this.fail('watcher-error');
      });
      this.watchers.push(watcher);
    }
  }
  private async changed(): Promise<void> {
    if (this.stopped) return;
    this.changes++;
    if (this.arming) return;
    if (this.failed) {
      this.recover();
      return;
    }
    const generation = this.generation;
    try {
      this.arm();
      if (this.receipt.ready) await this.fence();
      // Registration changes fail the account fingerprint fence and re-arm the owner.
      // Provider login/keychain state has no reliable subscribed feed. Its one structured
      // collector runs at >=60s; journal activity never starts additional account probes.
    } catch (error) {
      if (generation !== this.generation || this.stopped) return;
      this.fail(error instanceof NativeSourceUnavailable ? error.reason : 'watcher-rescan-failed');
      // A filesystem lifecycle event can reattach the one owner to a replacement host.
      this.recover();
    }
  }
  private recover(): void {
    if (this.recovering || this.stopped) return;
    this.recovering = this.retry()
      .catch(() => {
        this.fail('rearm-failed'); // Published failure; no timer or request replay. A new source event/Retry may arm again.
      })
      .finally(() => {
        this.recovering = undefined;
      });
  }
  private refreshAccounts(): void {
    if (this.refreshing) {
      this.queued = true;
      return;
    }
    this.refreshing = true;
    const generation = this.generation;
    const wasReady = !this.failed && Boolean(this.snapshot);
    let change: number;

    let before: SourceSnapshot;
    void Promise.resolve()
      .then(async () => {
        before = await this.scan();
        change = this.changes;
        return this.observeAccounts().catch((error: unknown) => this.sampleFailed(error));
      })
      .then(async (accounts) => {
        if (generation !== this.generation || this.stopped) return;
        if (change !== this.changes) {
          this.queued = true;
          return;
        }
        const digest = accountsDigest(accounts);
        const after = await this.scan();
        if (generation !== this.generation || this.stopped) return;
        if (after.accounts !== before.accounts) {
          this.queued = true;
          return;
        }
        if (after.host !== this.snapshot?.host) {
          this.fail('account-sample-host-changed');
          return;
        }
        const changed = digest !== this.accountDigest || after.digest !== this.snapshot?.digest;
        this.setAccounts(accounts);
        this.snapshot = after;
        // Only a previously armed source can recover here. Watcher errors require start().
        if (wasReady && !this.failed) this.receipt = { ...this.receipt, ready: true };
        if (changed || this.receipt.ready) this.advance(['profiles']);
      })
      .catch(() => {
        if (generation === this.generation) {
          this.fail('sample-scan-failed');
        }
      })
      .finally(() => {
        this.refreshing = false;
        if (generation !== this.generation || this.stopped) return;
        if (this.queued) {
          this.queued = false;
          this.refreshAccounts();
        }
      });
  }
  private scheduleAccounts(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.failed) this.recover();
      else this.refreshAccounts();
      if (!this.stopped) this.scheduleAccounts();
    }, 60_000);
    this.timer.unref();
  }
  /** At most one active scan and one queued batch. A fence never joins an older active scan. */
  private scan(): Promise<SourceSnapshot> {
    if (!this.queuedScan || this.queuedScanGeneration !== this.generation) {
      const generation = this.generation;
      let scan: Promise<SourceSnapshot>;
      const run = () => {
        if (this.queuedScan === scan) this.queuedScan = undefined;
        if (generation !== this.generation) throw new NativeSourceUnavailable('source-stopped');
        return this.scanFiles(generation);
      };
      scan = this.scanTail.then(run, run);
      this.queuedScan = scan;
      this.queuedScanGeneration = generation;
      this.scanTail = scan;
    }
    return this.queuedScan;
  }
  private async scanFiles(generation: number): Promise<SourceSnapshot> {
    const deadline = Date.now() + 30_000;
    const check = () => {
      if (generation !== this.generation || this.stopped)
        throw new NativeSourceUnavailable('source-stopped');
      if (Date.now() >= deadline) throw new NativeSourceUnavailable('scan-deadline');
    };
    check();
    const parts: string[] = [];
    let host = 'absent';
    const stat = await statIfPresent(this.client.root);
    if (stat) {
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.uid !== process.getuid?.() ||
        stat.mode & 0o077
      )
        throw new NativeSourceUnavailable('unsafe-source-root');
      parts.push(`${stat.dev}:${stat.ino}`);
      if (await statIfPresent(join(this.client.root, 'host.json'))) {
        const identity = await readJsonAsync<HostIdentity>(join(this.client.root, 'host.json'));
        const worker = await readJsonAsync<{ pid: number }>(join(this.client.root, 'worker.json'));
        const ready = await readJsonAsync<{ pid: number }>(join(this.client.root, 'ready.json'));
        if (
          (identity.executionNodeId ?? 'local') !== this.client.executionNodeId ||
          // host.json identifies the supervisor; readiness belongs to its registered child.
          ready.pid !== worker.pid ||
          !alive(identity.pid) ||
          !alive(worker.pid) ||
          !(await lstat(identity.socket)).isSocket()
        )
          throw new NativeSourceUnavailable('host-identity-invalid');
        host = hash(JSON.stringify([identity, worker.pid]));
      }
      const sessions = join(this.client.root, 'sessions');
      const directory = await statIfPresent(sessions);
      if (directory) {
        if (
          !directory.isDirectory() ||
          directory.isSymbolicLink() ||
          directory.uid !== process.getuid?.() ||
          directory.mode & 0o077
        )
          throw new NativeSourceUnavailable('unsafe-session-directory');
      }
      const retained = new Set<string>();
      if (directory)
        for (const file of (await readdir(sessions)).sort()) {
          check();
          if (!file.endsWith('.journal')) continue;
          const path = join(sessions, file);
          const stat = await lstat(path);
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.uid !== process.getuid?.() ||
            stat.mode & 0o077
          )
            throw new NativeSourceUnavailable('unsafe-journal');
          const stamp = journalStamp(stat);
          retained.add(file);
          const cached = this.journals.get(file);
          let digest = cached?.stamp === stamp ? cached.digest : undefined;
          if (digest === undefined) {
            const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
              const hash = createHash('sha256');
              const buffer = Buffer.allocUnsafe(64 * 1024);
              let position = 0;
              let lastByte: number | undefined;
              while (position < stat.size) {
                check();
                const { bytesRead } = await handle.read(
                  buffer,
                  0,
                  Math.min(buffer.length, stat.size - position),
                  position,
                );
                if (!bytesRead) throw new NativeSourceUnavailable('journal-changed-during-scan');
                hash.update(buffer.subarray(0, bytesRead));
                lastByte = buffer[bytesRead - 1];
                position += bytesRead;
              }
              // Observe a committed prefix, never truncate or consume an incomplete append.
              if (position && lastByte !== 10)
                throw new NativeSourceUnavailable('incomplete-journal-append');
              digest = hash.digest('hex');
              const after = await handle.stat();
              check();
              if (!after.isFile() || after.uid !== process.getuid?.() || after.mode & 0o077)
                throw new NativeSourceUnavailable('unsafe-journal');
              if (journalStamp(after) === stamp) this.journals.set(file, { stamp, digest });
            } finally {
              await handle.close();
            }
          }
          parts.push(file, `${stat.dev}:${stat.ino}`, digest);
        }
      for (const file of this.journals.keys()) if (!retained.has(file)) this.journals.delete(file);
    }
    host = hash([host, parts[0] ?? 'absent'].join('\n'));
    let profiles: unknown;
    try {
      profiles = await listNativeProfilesAsync(this.home);
    } catch {
      // An unreadable profile file fails the profile sample, not session observation.
      profiles = 'unreadable';
    }
    const accountFiles: string[] = [JSON.stringify(profiles)];
    const accounts = hash(accountFiles.join('\n'));
    parts.push(host, accounts);
    return { host, accounts, digest: hash(parts.join('\n')) };
  }
}
async function statIfPresent(file: string) {
  try {
    return await lstat(file);
  } catch (error) {
    // Missing host/session directories are an observed source state, not an I/O failure.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
function journalStamp(stat: Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}
function nearestDirectory(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) throw new NativeSourceUnavailable();
    current = parent;
  }
  return current;
}
/** An unavailable sample has its own digest, so a later successful one reads as a change. */
function accountsDigest(accounts: NativeProfileStatusResult[] | undefined): string {
  return hash(JSON.stringify(accounts ?? 'unavailable'));
}
function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
export function sameNativeSource(a: NativeSourceReceipt, b: NativeSourceReceipt): boolean {
  return (
    a.ready &&
    b.ready &&
    a.nodeId === b.nodeId &&
    a.ownerId === b.ownerId &&
    a.incarnation === b.incarnation &&
    a.revision === b.revision
  );
}
