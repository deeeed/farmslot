import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  assertSourceConfiguration,
  assertSourceEntry,
  canonicalSourceRepo,
  isRecord,
  type SourceConfiguration,
  type SourceEntryRef,
  type SourceLock,
  type SourceLockEntry,
  type SourceResolution,
} from '@farmslot/protocol';
import {
  type FetchedSource,
  sourceDigest,
  SourceGitStore,
  sourceLockDigest,
} from '@farmslot/slot-config/sources';

interface ResolutionRecord {
  resolution: SourceResolution;
  tree?: FetchedSource;
  dependencies: SourceEntryRef[];
}

interface AuthorityState {
  schemaVersion: 1;
  activatedAt: string;
  revision: number;
  declarationDigest: string;
  records: Record<string, ResolutionRecord>;
  locks: Record<string, SourceLock>;
}

/** Pure data dependency discovery. No import, provider execution or install step. */
export function sourceDependencies(value: unknown): SourceEntryRef[] {
  const result: SourceEntryRef[] = [];
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) item.forEach(visit);
    else if (isRecord(item)) {
      if ('sourceId' in item) {
        assertSourceEntry(item);
        result.push(item);
      } else Object.values(item).forEach(visit);
    } else if (typeof item === 'string') {
      for (const match of item.matchAll(/\{\{source:([a-zA-Z0-9._-]+)\}\}/g))
        result.push({ sourceId: match[1], entry: '.' });
    }
  };
  visit(value);
  return [...new Map(result.map((entry) => [`${entry.sourceId}/${entry.entry}`, entry])).values()];
}

/** Sole gateway ref resolver. Publication is serialized and persisted before it is observable. */
export class SourceAuthority {
  private pending = Promise.resolve();
  private state: AuthorityState;

  private constructor(
    readonly configuration: SourceConfiguration,
    readonly root: string,
    readonly git: SourceGitStore,
    state: AuthorityState,
    private readonly now: () => number,
  ) {
    this.state = state;
  }

  static async open(
    configuration: SourceConfiguration,
    root: string,
    git = new SourceGitStore(root),
    now: () => number = Date.now,
  ): Promise<SourceAuthority> {
    assertSourceConfiguration(configuration);
    let state: AuthorityState = {
      schemaVersion: 1,
      activatedAt: new Date(now()).toISOString(),
      revision: configuration.revision,
      declarationDigest: sourceDigest(configuration),
      records: {},
      locks: {},
    };
    try {
      state = JSON.parse(await readFile(path.join(root, 'authority.json'), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (
      state.schemaVersion !== 1 ||
      state.revision > configuration.revision ||
      !Number.isFinite(Date.parse(state.activatedAt)) ||
      (state.revision === configuration.revision &&
        state.declarationDigest !== sourceDigest(configuration))
    )
      throw new Error('Unsupported source state or declaration rollback');
    return new SourceAuthority(structuredClone(configuration), root, git, state, now);
  }

  private key(sourceId: string, ref: string): string {
    return JSON.stringify([sourceId, ref, this.configuration.revision]);
  }

  resolutions(): SourceResolution[] {
    return Object.values(this.state.records).map(({ resolution }) => {
      const copy = structuredClone(resolution);
      if (
        copy.status === 'resolved' &&
        this.now() - Date.parse(copy.resolvedAt ?? '') > this.configuration.pollIntervalMs * 2
      )
        copy.status = 'stale';
      return copy;
    });
  }

  locks(): SourceLock[] {
    return structuredClone(Object.values(this.state.locks));
  }

  affectedProjects(sourceId?: string): string[] {
    if (sourceId && !this.configuration.sources.some((source) => source.id === sourceId))
      throw new Error(`Undeclared source: ${sourceId}`);
    const includes = (id: string, seen: Set<string>): boolean => {
      if (id === sourceId) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      const declaration = this.configuration.sources.find((source) => source.id === id);
      if (!declaration) return false;
      const record = this.state.records[this.key(id, declaration.ref ?? 'main')];
      return (
        record?.dependencies.some((dependency) => includes(dependency.sourceId, seen)) ?? false
      );
    };
    return Object.entries(this.configuration.packs)
      .filter(([, pack]) => !sourceId || includes(pack.sourceId, new Set()))
      .map(([project]) => project);
  }
  activatedAt(): string {
    return this.state.activatedAt;
  }

  private async persist(state: AuthorityState): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const temporary = path.join(this.root, `authority.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
    await rename(temporary, path.join(this.root, 'authority.json'));
    this.state = state;
  }

  /** Each selected source/ref resolves independently. One failure does not stale unrelated records. */
  async reconcile(
    sourceIds = this.configuration.sources.map((source) => source.id),
  ): Promise<void> {
    return this.serialize(async () => {
      const next = structuredClone(this.state);
      next.revision = this.configuration.revision;
      next.declarationDigest = sourceDigest(this.configuration);
      for (const id of sourceIds) {
        const declaration = this.configuration.sources.find((source) => source.id === id);
        if (!declaration) throw new Error(`Undeclared source: ${id}`);
        const ref = declaration.ref ?? 'main';
        const key = this.key(id, ref);
        const previous = next.records[key];
        const resolution: SourceResolution = {
          ...previous?.resolution,
          sourceId: id,
          ref,
          declarationRevision: this.configuration.revision,
          generation: previous?.resolution.generation ?? 0,
          status: 'failed',
          rewrites: previous?.resolution.rewrites ?? [],
        };
        try {
          const tree = await this.git.resolve(declaration, ref);
          if (
            tree.refKind === 'tag' &&
            previous?.tree &&
            previous.tree.refObject !== tree.refObject
          )
            throw new Error('Source tag was rewritten; revise its declaration before adoption');
          const manifest = await this.git.readJson(declaration.repo, tree, 'farm-sources.json');
          if (
            manifest !== undefined &&
            (!isRecord(manifest) ||
              manifest.schemaVersion !== 1 ||
              !Array.isArray(manifest.dependencies) ||
              Object.keys(manifest).some((key) => !['schemaVersion', 'dependencies'].includes(key)))
          )
            throw new Error('Invalid or unsupported source dependency manifest');
          const bindings = Object.values(this.configuration.packs).filter(
            (binding) => binding.sourceId === id,
          );
          const dependencies: SourceEntryRef[] = sourceDependencies(manifest);
          for (const binding of bindings) {
            const entry = path.posix.join(binding.entry, 'project.json');
            const project = await this.git.readJson(declaration.repo, tree, entry);
            if (!project)
              throw new Error(`Declared pack has no project.json: ${id}/${binding.entry}`);
            dependencies.push(...sourceDependencies(project));
            const texts: string[] = [];
            const collect = (value: unknown): void => {
              if (typeof value === 'string') texts.push(value);
              else if (Array.isArray(value)) value.forEach(collect);
              else if (isRecord(value)) Object.values(value).forEach(collect);
            };
            collect(project);
            for (const text of texts) {
              for (const match of text.matchAll(
                /\{\{(?:farmslot_dir|FARMSLOT_DIR)\}\}\/projects\/([a-zA-Z0-9._-]+)/g,
              )) {
                const referenced = this.configuration.packs[match[1]];
                if (!referenced) throw new Error('Pack references an undeclared pack');
                dependencies.push(referenced);
              }
            }
          }
          if (
            dependencies.some(
              (dependency) =>
                !this.configuration.sources.some((source) => source.id === dependency.sourceId),
            )
          )
            throw new Error('Source references an undeclared dependency');
          const observedAt = new Date(this.now()).toISOString();
          if (previous?.tree && previous.tree.commit !== tree.commit && tree.refKind === 'branch') {
            const ancestry = await this.git.git(declaration.repo, ['rev-list', tree.commit]);
            if (!ancestry.toString().split('\n').includes(previous.tree.commit))
              resolution.rewrites.push({
                before: previous.tree.commit,
                after: tree.commit,
                observedAt,
              });
          }
          Object.assign(resolution, {
            generation: resolution.generation + (previous?.tree?.commit === tree.commit ? 0 : 1),
            commit: tree.commit,
            refObject: tree.refObject,
            objectFormat: tree.objectFormat,
            treeDigest: tree.treeDigest,
            resolvedAt: observedAt,
            status: 'resolved',
          });
          delete resolution.reason;
          for (const binding of dependencies.filter((dependency) => dependency.sourceId === id)) {
            const prefix = binding.entry === '.' ? '' : `${binding.entry}/`;
            if (
              !tree.files.some(
                (file) => file.path === binding.entry || file.path.startsWith(prefix),
              )
            )
              throw new Error('Contained self-source entry is missing');
          }
          next.records[key] = {
            resolution,
            tree,
            dependencies: dependencies.filter((dependency) => dependency.sourceId !== id),
          };
        } catch (error) {
          // Keep the prior exact objects and report this failure. They cannot authorize new locks.
          resolution.status = 'failed';
          resolution.reason = `Source ${id} resolution failed: ${(error as Error).message}`;
          next.records[key] = {
            ...previous,
            resolution,
            dependencies: previous?.dependencies ?? [],
          };
        }
      }
      await this.persist(next);
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.pending.then(operation);
    this.pending = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }

  lock(context: SourceLock['context']): Promise<SourceLock> {
    return this.serialize(async () => {
      const pack = this.configuration.packs[context.project];
      if (!pack) throw new Error(`No declared pack binding: ${context.project}`);
      const entries = new Map<string, SourceLockEntry>();
      const visit = (binding: SourceEntryRef, stack: string[]): void => {
        if (stack.includes(binding.sourceId)) throw new Error('Cyclic source dependencies');
        const declaration = this.configuration.sources.find(
          (source) => source.id === binding.sourceId,
        );
        if (!declaration) throw new Error(`Undeclared source: ${binding.sourceId}`);
        const ref = declaration.ref ?? 'main';
        const record = this.state.records[this.key(declaration.id, ref)];
        if (
          !record?.tree ||
          record.resolution.status !== 'resolved' ||
          this.now() - Date.parse(record.resolution.resolvedAt ?? '') >
            this.configuration.pollIntervalMs * 2
        )
          throw new Error(`Source is unavailable or stale: ${declaration.id}`);
        const prefix = binding.entry === '.' ? '' : `${binding.entry}/`;
        if (
          !record.tree.files.some(
            (file) => file.path === binding.entry || file.path.startsWith(prefix),
          )
        )
          throw new Error(`Source entry is missing: ${binding.sourceId}/${binding.entry}`);
        if (entries.has(declaration.id)) return;
        const entry: SourceLockEntry = {
          sourceId: declaration.id,
          kind: declaration.kind,
          repo: canonicalSourceRepo(declaration.repo),
          declaredRef: ref,
          effectiveRef: ref,
          commit: record.tree.commit,
          objectFormat: record.tree.objectFormat,
          treeDigest: record.tree.treeDigest,
          resolutionGeneration: record.resolution.generation,
          scope: 'farm',
          dependencies: record.dependencies,
        };
        entries.set(declaration.id, entry);
        for (const dependency of record.dependencies) visit(dependency, [...stack, declaration.id]);
      };
      visit(pack, []);
      const key = JSON.stringify(context);
      const selected = [...entries.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId));
      const previous = this.state.locks[key];
      if (
        previous?.declarationRevision === this.configuration.revision &&
        sourceDigest(previous.entries) === sourceDigest(selected)
      )
        return structuredClone(previous);
      const content: Omit<SourceLock, 'digest'> = {
        schemaVersion: 1,
        context,
        generation: (this.state.locks[key]?.generation ?? 0) + 1,
        declarationRevision: this.configuration.revision,
        pinRevision: 0,
        resolvedAt: new Date(this.now()).toISOString(),
        entries: selected,
        packBindings: Object.fromEntries(
          Object.entries(this.configuration.packs).filter(([, binding]) =>
            entries.has(binding.sourceId),
          ),
        ),
      };
      const lock = { ...content, digest: sourceLockDigest(content) };
      const next = structuredClone(this.state);
      next.locks[key] = lock;
      await this.persist(next);
      return structuredClone(lock);
    });
  }
}
