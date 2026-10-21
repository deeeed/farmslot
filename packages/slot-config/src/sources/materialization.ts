import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  type SourceLock,
  type SourceLockEntry,
  type SourceMaterialization,
  type SourceNodeStatus,
} from '@farmslot/protocol';

import {
  type SourceCommand,
  sourceCommand,
  sourceDigest,
  SourceGitStore,
  type SourceTreeFile,
} from './git.js';
import { assertSourceLock } from './lock.js';

export interface SourceVolume {
  publish(tree: string, image: string, mount: string): Promise<void>;
  verify(mount: string): Promise<void>;
  restore(image: string, mount: string): Promise<void>;
}

export class SourceVolumeMissing extends Error {}

interface SourceDiskImage {
  'image-path': string;
  'system-entities': Array<{ 'dev-entry': string; 'content-hint': string }>;
}

/** A read-only filesystem, rather than mode bits that the same worker UID can undo. */
export class ReadOnlySourceVolume implements SourceVolume {
  constructor(private readonly command: SourceCommand = sourceCommand) {}

  private async detachOwnedImage(images: string[]): Promise<void> {
    const temporary = path.join(os.tmpdir(), `source-images-${randomUUID()}.plist`);
    try {
      await writeFile(temporary, await this.command('hdiutil', ['info', '-plist']), { flag: 'wx' });
      const data = JSON.parse(
        (await this.command('plutil', ['-convert', 'json', '-o', '-', temporary])).toString(),
      ) as { images: SourceDiskImage[] };
      for (const image of data.images.filter((value) => images.includes(value['image-path']))) {
        const device = image['system-entities'].find((entry) =>
          /^\/dev\/disk\d+$/.test(entry['dev-entry']),
        )?.['dev-entry'];
        if (!device) throw new Error('Owned source image has no detachable device identity');
        await this.command('hdiutil', ['detach', '-quiet', device]);
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async publish(tree: string, image: string, mount: string): Promise<void> {
    await mkdir(mount, { recursive: true });
    let imagePresent = true;
    try {
      await lstat(image);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      imagePresent = false;
    }
    if (process.platform === 'darwin') {
      if (!imagePresent) {
        const incoming = `${image}.${randomUUID()}.dmg`;
        try {
          await this.command('hdiutil', [
            'create',
            '-quiet',
            '-srcfolder',
            tree,
            '-format',
            'UDRO',
            '-fs',
            'HFS+',
            incoming,
          ]);
          await this.detachOwnedImage([incoming]);
          await rename(incoming, image);
        } catch (error) {
          await this.detachOwnedImage([incoming, image]);
          throw error;
        }
      }
      try {
        await this.command('hdiutil', [
          'attach',
          '-readonly',
          '-nobrowse',
          '-quiet',
          '-mountpoint',
          mount,
          image,
        ]);
      } catch (error) {
        await this.detachOwnedImage([image]);
        throw error;
      }
    } else if (process.platform === 'linux') {
      if (!imagePresent) {
        const incoming = `${image}.${randomUUID()}.squashfs`;
        await this.command('mksquashfs', [tree, incoming, '-noappend', '-no-progress']);
        await rename(incoming, image);
      }
      await this.command('mount', ['-o', 'loop,ro,nosuid,nodev', image, mount]);
    } else throw new Error('Read-only source volumes are unsupported on this platform');
    await this.verify(mount);
  }

  async restore(image: string, mount: string): Promise<void> {
    try {
      await this.verify(mount);
      return;
    } catch (error) {
      // A reboot loses mounts, not the retained image. Writable or substituted
      // mounts still refuse; never hide files by mounting over a changed tree.
      if (!(error instanceof SourceVolumeMissing)) throw error;
    }
    await lstat(image);
    if ((await readdir(mount)).length) throw new Error('Unmounted source path contains files');
    await this.publish('', image, mount);
  }

  async verify(mount: string): Promise<void> {
    if ((await realpath(mount)) !== mount) throw new Error('Source mount path was substituted');
    if (process.platform === 'darwin') {
      // diskutil cannot identify an ordinary directory after its image detaches.
      // A source image has a distinct device from the directory containing it.
      if ((await lstat(mount)).dev === (await lstat(path.dirname(mount))).dev)
        throw new SourceVolumeMissing('Source volume is missing');
      const plist = (await this.command('diskutil', ['info', '-plist', mount])).toString();
      const location = /<key>MountPoint<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
      if (location !== mount) throw new SourceVolumeMissing('Source volume is missing');
      if (!/<key>WritableVolume<\/key>\s*<false\/>/.test(plist))
        throw new Error('Source volume is writable');
    } else if (process.platform === 'linux') {
      const report = JSON.parse(
        (
          await this.command('findmnt', ['--json', '--target', mount, '--output', 'TARGET,OPTIONS'])
        ).toString(),
      );
      const volume = report.filesystems?.[0];
      if (volume?.target !== mount) throw new SourceVolumeMissing('Source volume is missing');
      if (!String(volume.options).split(',').includes('ro'))
        throw new Error('Source volume is writable');
    } else throw new Error('Read-only source volumes are unsupported on this platform');
  }
}

function blobIdentity(content: Buffer, format: 'sha1' | 'sha256'): string {
  return createHash(format).update(`blob ${content.length}\0`).update(content).digest('hex');
}

export async function sourceTreeIdentity(root: string, format: 'sha1' | 'sha256'): Promise<string> {
  const files: SourceTreeFile[] = [];
  const canonicalRoot = await realpath(root);
  const visit = async (relative: string): Promise<void> => {
    const absolute = path.join(root, relative);
    const info = await lstat(absolute);
    if (info.isDirectory()) {
      for (const name of (await readdir(absolute)).sort())
        await visit(path.posix.join(relative, name));
    } else if (info.isFile()) {
      files.push({
        path: relative,
        mode: info.mode & 0o111 ? '100755' : '100644',
        object: blobIdentity(await readFile(absolute), format),
      });
    } else if (info.isSymbolicLink()) {
      const target = await realpath(absolute);
      const within = path.relative(canonicalRoot, target);
      if (within === '..' || within.startsWith('../') || path.isAbsolute(within))
        throw new Error(`Source symlink escapes its tree: ${relative}`);
      files.push({
        path: relative,
        mode: '120000',
        object: blobIdentity(Buffer.from(await readlink(absolute)), format),
      });
    } else throw new Error(`Unsupported source file: ${relative}`);
  };
  await visit('');
  files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return sourceDigest(files);
}

export class SourceMaterializer {
  private pending = Promise.resolve();

  constructor(
    readonly nodeId: string,
    readonly root: string,
    readonly git = new SourceGitStore(root),
    private readonly volume: SourceVolume = new ReadOnlySourceVolume(),
  ) {}

  private sourceKey(entry: SourceLockEntry): string {
    return sourceDigest({
      repo: entry.repo,
      commit: entry.commit,
      treeDigest: entry.treeDigest,
      format: entry.objectFormat,
    });
  }

  private mount(entry: SourceLockEntry): string {
    return path.join(this.root, 'mounts', this.sourceKey(entry));
  }

  private sourceRoot(entry: SourceLockEntry): string {
    return path.join(this.mount(entry), 'tree');
  }

  private async readReceipt(lock: SourceLock): Promise<SourceMaterialization> {
    assertSourceLock(lock);
    const stored = JSON.parse(
      await readFile(path.join(this.root, 'receipts', `${lock.digest}.json`), 'utf8'),
    ) as SourceMaterialization;
    const facts = lock.entries.map((entry) => ({
      sourceId: entry.sourceId,
      commit: entry.commit,
      treeDigest: entry.treeDigest,
      protection: 'read-only-volume',
    }));
    if (
      stored.lock.digest !== lock.digest ||
      sourceDigest(stored.lock) !== sourceDigest(lock) ||
      stored.receipt.nodeId !== this.nodeId ||
      stored.receipt.schemaVersion !== 1 ||
      stored.receipt.lockDigest !== lock.digest ||
      sourceDigest(stored.receipt.sources) !== sourceDigest(facts) ||
      stored.receiptPath !== path.join(this.root, 'receipts', `${lock.digest}.json`)
    )
      throw new Error('Source receipt does not match the authorized lock and node');
    for (const entry of lock.entries)
      if (stored.roots[entry.sourceId] !== this.sourceRoot(entry))
        throw new Error('Source root was substituted');
    return stored;
  }

  async verify(lock: SourceLock): Promise<SourceMaterialization> {
    return this.verifyMaterialization(lock, new Map());
  }

  private async verifyMaterialization(
    lock: SourceLock,
    verifiedTrees: Map<string, Promise<boolean>>,
  ): Promise<SourceMaterialization> {
    const stored = await this.readReceipt(lock);
    for (const entry of lock.entries) {
      const key = this.sourceKey(entry);
      let checked = verifiedTrees.get(key);
      if (!checked) {
        checked = (async () => {
          await this.volume.verify(this.mount(entry));
          return (
            (await sourceTreeIdentity(this.sourceRoot(entry), entry.objectFormat)) ===
            entry.treeDigest
          );
        })();
        verifiedTrees.set(key, checked);
      }
      if (!(await checked)) throw new Error(`Source drift: ${entry.sourceId}`);
    }
    return stored;
  }

  materialize(lock: SourceLock): Promise<SourceMaterialization> {
    const work = this.pending.then(() => this.publish(lock));
    // A failed publication refuses its caller. Later independent locks can still reconcile.
    this.pending = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }

  private async publish(lock: SourceLock): Promise<SourceMaterialization> {
    assertSourceLock(lock);
    await mkdir(path.join(this.root, 'receipts'), { recursive: true });
    const receiptFile = path.join(this.root, 'receipts', `${lock.digest}.json`);
    let receiptPresent = true;
    try {
      await readFile(receiptFile);
    } catch (error) {
      // Only a missing receipt permits first publication. Drift never repairs silently.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      receiptPresent = false;
    }
    if (receiptPresent) {
      await this.readReceipt(lock);
      for (const entry of lock.entries)
        await this.volume.restore(
          path.join(this.root, 'images', `${this.sourceKey(entry)}.dmg`),
          this.mount(entry),
        );
      return this.verify(lock);
    }
    const roots: Record<string, string> = {};
    for (const entry of lock.entries) {
      const mount = this.mount(entry);
      const root = this.sourceRoot(entry);
      try {
        await lstat(root);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const tree = await this.git.retain(entry.repo, entry.commit, entry.objectFormat);
        if (tree.treeDigest !== entry.treeDigest)
          throw new Error('Fetched source does not match the lock');
        const staging = await mkdtemp(path.join(os.tmpdir(), 'farm-source-'));
        try {
          await mkdir(path.join(staging, 'tree'));
          await this.git.export(entry.repo, tree, path.join(staging, 'tree'));
          if (
            (await sourceTreeIdentity(path.join(staging, 'tree'), entry.objectFormat)) !==
            entry.treeDigest
          )
            throw new Error('Source staging identity mismatch');
          await mkdir(path.join(this.root, 'images'), { recursive: true });
          await this.volume.publish(
            staging,
            path.join(this.root, 'images', `${this.sourceKey(entry)}.dmg`),
            mount,
          );
        } finally {
          await rm(staging, { recursive: true, force: true });
        }
      }
      await this.volume.verify(mount);
      if ((await sourceTreeIdentity(root, entry.objectFormat)) !== entry.treeDigest)
        throw new Error(`Source drift: ${entry.sourceId}`);
      roots[entry.sourceId] = root;
    }
    const value: SourceMaterialization = {
      lock,
      roots,
      receiptPath: receiptFile,
      receipt: {
        schemaVersion: 1,
        id: randomUUID(),
        nodeId: this.nodeId,
        lockDigest: lock.digest,
        verifiedAt: new Date().toISOString(),
        sources: lock.entries.map((entry) => ({
          sourceId: entry.sourceId,
          commit: entry.commit,
          treeDigest: entry.treeDigest,
          protection: 'read-only-volume',
        })),
      },
    };
    const temporary = `${receiptFile}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    await rename(temporary, receiptFile);
    return value;
  }

  async status(): Promise<SourceNodeStatus> {
    let files: string[];
    try {
      files = await readdir(path.join(this.root, 'receipts'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      files = [];
    }
    const materializations: SourceNodeStatus['materializations'] = [];
    // Historical receipts often share a protected tree. Each read verifies that tree once,
    // while still validating every receipt; the next read and every execution start fresh.
    const verifiedTrees = new Map<string, Promise<boolean>>();
    for (const file of files.filter((name) => /^[0-9a-f]{64}\.json$/.test(name))) {
      const stored = JSON.parse(
        await readFile(path.join(this.root, 'receipts', file), 'utf8'),
      ) as SourceMaterialization;
      try {
        const verified = await this.verifyMaterialization(stored.lock, verifiedTrees);
        materializations.push({
          lockDigest: stored.lock.digest,
          sources: verified.receipt.sources,
          verifiedAt: new Date().toISOString(),
          drift: [],
        });
      } catch (error) {
        materializations.push({
          lockDigest: stored.lock.digest,
          sources: stored.receipt.sources,
          drift: [(error as Error).message],
        });
      }
    }
    return { nodeId: this.nodeId, materializations };
  }
}
