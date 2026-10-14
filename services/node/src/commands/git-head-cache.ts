import { type ChildProcess, execFile } from 'node:child_process';
import { type FSWatcher, watch } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const RECHECK_MS = 10_000;

interface GitLocation {
  checkedAt: number;
  marker?: string;
  gitDir?: string;
}

interface GitHead {
  checkedAt: number;
  version: number;
  checkedVersion: number;
  content?: string;
  branch?: string;
  pending?: Promise<string | undefined>;
  watcher?: FSWatcher;
}

function metadataUnavailable(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '');
}

async function optionalText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (metadataUnavailable(error)) return undefined;
    throw error;
  }
}

async function optionalStat(file: string): Promise<Awaited<ReturnType<typeof stat>> | undefined> {
  try {
    return await stat(file);
  } catch (error) {
    if (metadataUnavailable(error)) return undefined;
    throw error;
  }
}

/** Discover repository markers without launching Git for ordinary shell directories. */
async function repositoryMarker(cwd: string): Promise<string | undefined> {
  let directory = path.resolve(cwd);
  for (;;) {
    const dotGit = path.join(directory, '.git');
    const metadata = await optionalStat(dotGit);
    if (metadata?.isDirectory()) return `${dotGit}:${metadata.dev}:${metadata.ino}`;
    if (metadata?.isFile()) {
      const pointer = await optionalText(dotGit);
      return pointer === undefined ? undefined : `${dotGit}:${pointer}`;
    }
    // Bare repositories and panes inside .git also have a repository HEAD.
    if (
      (await optionalStat(path.join(directory, 'HEAD')))?.isFile() &&
      (await optionalStat(path.join(directory, 'objects')))?.isDirectory()
    )
      return `${directory}:bare`;
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/** One HEAD observer per worktree, shared by panes, directories and simultaneous inventories. */
export class GitHeadCache {
  private readonly locations = new Map<string, GitLocation>();
  private readonly heads = new Map<string, GitHead>();
  private readonly pending = new Map<string, Promise<string | undefined>>();
  private readonly children = new Map<ChildProcess, Promise<void>>();
  private closed = false;

  constructor(
    private readonly onChange: () => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  read(cwd: string | undefined): Promise<string | undefined> {
    if (!cwd || this.closed) return Promise.resolve(undefined);
    const existing = this.pending.get(cwd);
    if (existing) return existing;
    const pending = this.readDirectory(cwd).finally(() => this.pending.delete(cwd));
    this.pending.set(cwd, pending);
    return pending;
  }

  private git(cwd: string, args: string[]): Promise<string | undefined> {
    if (this.closed) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      let value: string | undefined;
      const child = execFile(
        'git',
        ['-C', cwd, ...args],
        {
          timeout: 1000,
          killSignal: 'SIGKILL',
        },
        (error, stdout) => {
          value = error ? undefined : stdout.trim() || undefined;
        },
      );
      const reaped = new Promise<void>((done) => {
        child.once('close', () => {
          this.children.delete(child);
          done();
          resolve(value);
        });
      });
      this.children.set(child, reaped);
    });
  }

  private async readDirectory(cwd: string): Promise<string | undefined> {
    const now = this.now();
    let location = this.locations.get(cwd);
    if (!location || now - location.checkedAt > RECHECK_MS) {
      const marker = await repositoryMarker(cwd);
      const gitDir = marker
        ? marker === location?.marker && location.gitDir
          ? location.gitDir
          : await this.git(cwd, ['rev-parse', '--absolute-git-dir'])
        : undefined;
      location = { checkedAt: now, marker, gitDir };
      this.locations.set(cwd, location);
    }
    if (!location.gitDir || this.closed) return undefined;
    const gitDir = location.gitDir;
    let head = this.heads.get(gitDir);
    if (!head) {
      head = { checkedAt: -Infinity, version: 0, checkedVersion: -1 };
      this.heads.set(gitDir, head);
      try {
        const target = head;
        target.watcher = watch(gitDir, { persistent: false }, (_event, name) => {
          if (name !== null && name.toString() !== 'HEAD') return;
          target.version++;
          this.onChange();
        });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!['ENOENT', 'ENOTDIR', 'EACCES', 'ENOSPC'].includes(code ?? '')) throw error;
        // The bounded filesystem recheck still observes HEAD when watching is unavailable.
      }
    }
    if (head.pending) return head.pending;
    if (head.checkedVersion === head.version && now - head.checkedAt <= RECHECK_MS) {
      return head.branch;
    }
    const target = head;
    target.pending = this.refresh(cwd, gitDir, target).finally(() => {
      target.pending = undefined;
    });
    return target.pending;
  }

  private async refresh(cwd: string, gitDir: string, head: GitHead): Promise<string | undefined> {
    const version = head.version;
    // A removed/unreadable worktree must lose its old branch, not keep displaying it.
    const content = await optionalText(path.join(gitDir, 'HEAD'));
    if (content !== head.content || !head.branch) {
      head.branch =
        (await this.git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])) ??
        (await this.git(cwd, ['rev-parse', '--short', 'HEAD']));
    }
    head.content = content;
    head.checkedAt = this.now();
    head.checkedVersion = version;
    return head.branch;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const head of this.heads.values()) head.watcher?.close();
    // Only our read-only Git children. Await close, which follows libuv's waitpid/reap.
    for (const child of this.children.keys()) child.kill('SIGKILL');
    await Promise.all(this.children.values());
    await Promise.all(this.pending.values());
    this.heads.clear();
    this.locations.clear();
  }
}
