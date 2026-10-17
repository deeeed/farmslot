import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  assertSourceConfiguration,
  assertSourceEntry,
  canonicalSourceRepo,
  isRecord,
  selectEffectiveSource,
  type SourceConfiguration,
  type SourceEntryRef,
  type SourceLock,
  type SourceLockEntry,
  type SourcePin,
  type SourcePinTarget,
  type SourceResolution,
  type SourceSelection,
  type SourcesPinParams,
  type SourcesPinResult,
  type SourcesUnpinParams,
  validateSourceSelections,
} from '@farmslot/protocol';
import { validatePackFilePortability } from '@farmslot/protocol/node/pack-portability';
import {
  type FetchedSource,
  sourceDigest,
  SourceGitStore,
  sourceLockDigest,
} from '@farmslot/slot-config/sources';

import { GatewayMethodError } from '../core/method-error.js';

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
  pinRevision: number;
  pins: Record<string, SourcePin>;
  pinOperations: Record<string, { requestDigest: string; result: SourcesPinResult }>;
  pendingRunCreations: string[];
}

/** Gateway-owned selections remain provisional until their complete plan is sealed. */
export interface PreparedSourcePins {
  creationRunId?: string;
  declarationRevision: number;
  previousPinRevision: number;
  pins: SourcePin[];
  operation?: { requestDigest: string; result: SourcesPinResult };
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
  private resolving = new Map<string, Promise<void>>();
  private observers = new Set<() => void>();
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
      pinRevision: 0,
      pins: {},
      pinOperations: {},
      pendingRunCreations: [],
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
    state.pinRevision ??= 0;
    state.pins ??= {};
    state.pinOperations ??= {};
    state.pendingRunCreations ??= [];
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

  pinRevision(): number {
    return this.state.pinRevision;
  }

  pins(): SourcePin[] {
    return structuredClone(Object.values(this.state.pins));
  }

  effectiveSelections(context: SourceLock['context'] | { nodeId?: string; runId?: string } = {}) {
    return this.configuration.sources.map((source) =>
      selectEffectiveSource(source, this.pins(), context),
    );
  }

  async mutatePin(
    params: SourcesPinParams | SourcesUnpinParams,
    actor: string,
    selection: 'branch' | 'main',
    assertTarget: () => void,
  ): Promise<SourcesPinResult> {
    const prepared = await this.preparePinMutation(params, actor, selection, assertTarget);
    if (!('pins' in prepared)) return prepared;
    return this.publishPins(prepared, [], assertTarget, () => prepared.operation!.result);
  }

  async preparePinMutation(
    params: SourcesPinParams | SourcesUnpinParams,
    actor: string,
    selection: 'branch' | 'main',
    assertTarget: () => void,
  ): Promise<PreparedSourcePins | SourcesPinResult> {
    const requestDigest = sourceDigest({ params, actor, selection });
    const check = (): SourcesPinResult | undefined => {
      const prior = this.state.pinOperations[params.operationId];
      if (prior) {
        if (prior.requestDigest !== requestDigest)
          throw new Error('Source operation identity was reused with a different request');
        return structuredClone(prior.result);
      }
      if (
        typeof params.operationId !== 'string' ||
        !params.operationId ||
        params.operationId.length > 128 ||
        !actor
      )
        throw new Error('Missing source mutation identity');
      const fields = [
        'sourceId',
        'scope',
        'targetId',
        'operationId',
        'expectedDeclarationRevision',
        'expectedPinRevision',
        ...(selection === 'branch' ? ['ref'] : []),
      ];
      if (Object.keys(params).some((key) => !fields.includes(key)))
        throw new Error('Source mutations contain unsupported fields');
      if (
        params.expectedDeclarationRevision !== this.configuration.revision ||
        params.expectedPinRevision !== this.state.pinRevision
      )
        throw new GatewayMethodError(
          'SOURCE_STATE_STALE',
          'Stale source declaration or pin revision',
        );
      if (
        !['farm', 'node', 'run'].includes(params.scope) ||
        !params.targetId ||
        (params.scope === 'farm' && params.targetId !== 'farm')
      )
        throw new Error('Select one source pin scope and its target');
      assertTarget();
      return undefined;
    };
    const prior = await this.serialize(async () => check());
    if (prior) return prior;
    // Fetches happen outside the admission transaction. A stale mutation cannot
    // change effective pins, and an unrelated closure can still admit work.
    const selected: SourceSelection = {
      sourceId: params.sourceId,
      selection,
      ...(selection === 'branch' ? { ref: (params as SourcesPinParams).ref } : {}),
    };
    await this.resolveSelections([selected]);
    return this.serialize(async () => {
      const retry = check();
      if (retry) return retry;
      const pin = this.pinForSelection(selected, params, actor);
      const result = {
        operationId: params.operationId,
        declarationRevision: this.configuration.revision,
        pinRevision: pin.revision!,
        pin,
      };
      return {
        declarationRevision: this.configuration.revision,
        previousPinRevision: this.state.pinRevision,
        pins: [pin],
        operation: { requestDigest, result },
      };
    });
  }

  async prepareRunSelections(
    runId: string,
    selections: readonly SourceSelection[],
    actor: string,
  ): Promise<PreparedSourcePins> {
    if (!runId || !actor) throw new Error('Missing source creation identity');
    const declarationRevision = this.configuration.revision;
    const previousPinRevision = this.state.pinRevision;
    await this.resolveSelections(selections);
    return this.serialize(async () => {
      if (
        declarationRevision !== this.configuration.revision ||
        previousPinRevision !== this.state.pinRevision
      )
        throw new GatewayMethodError(
          'SOURCE_STATE_STALE',
          'Source selections changed during creation planning',
        );
      return {
        creationRunId: runId,
        declarationRevision,
        previousPinRevision,
        pins: selections.map((selection) =>
          this.pinForSelection(selection, { scope: 'run', targetId: runId }, actor),
        ),
      };
    });
  }

  private async resolveSelections(selections: readonly SourceSelection[]): Promise<void> {
    const errors = validateSourceSelections(selections, this.configuration.sources);
    if (!selections.length) errors.push('Select each declared source once.');
    if (errors.length) throw new Error(errors.join(' '));
    await Promise.all(
      selections.flatMap((selection) =>
        [...new Set([this.selectionRef(selection), 'main'])].map((ref) =>
          this.reconcileSource(selection.sourceId, ref),
        ),
      ),
    );
  }

  private selectionRef(selection: SourceSelection): string {
    return selection.selection === 'main' ? 'main' : selection.ref!.replace(/^refs\/heads\//, '');
  }

  private pinForSelection(
    selection: SourceSelection,
    target: SourcePinTarget,
    actor: string,
  ): SourcePin {
    const ref = this.selectionRef(selection);
    const resolved = this.state.records[this.key(selection.sourceId, ref)];
    const main = this.state.records[this.key(selection.sourceId, 'main')];
    if (
      resolved?.resolution.status !== 'resolved' ||
      resolved.tree?.refKind !== 'branch' ||
      main?.resolution.status !== 'resolved' ||
      main.tree?.refKind !== 'branch'
    )
      throw new Error('Pins require a pushed branch and a resolved main branch');
    return {
      sourceId: selection.sourceId,
      ...target,
      selection: selection.selection,
      ref,
      actor,
      declarationRevision: this.configuration.revision,
      revision: this.state.pinRevision + 1,
      baseMainCommit: main.tree.commit,
      createdAt: new Date(this.now()).toISOString(),
    };
  }

  private preparedPins(prepared: PreparedSourcePins): SourcePin[] {
    if (
      prepared.declarationRevision !== this.configuration.revision ||
      prepared.previousPinRevision !== this.state.pinRevision
    )
      throw new GatewayMethodError(
        'SOURCE_STATE_STALE',
        'Stale source declaration or pin revision',
      );
    const pins = new Map(
      this.pins().map((pin) => [JSON.stringify([pin.scope, pin.targetId, pin.sourceId]), pin]),
    );
    for (const pin of prepared.pins)
      pins.set(JSON.stringify([pin.scope, pin.targetId, pin.sourceId]), pin);
    return [...pins.values()];
  }

  /** The only callback is synchronous run registration or publication of an already validated plan. */
  publishPins<T>(
    prepared: PreparedSourcePins,
    locks: readonly SourceLock[],
    assertTarget: () => void,
    publish: () => T,
  ): Promise<T> {
    return this.serialize(async () => {
      if (prepared.operation) {
        const prior = this.state.pinOperations[prepared.operation.result.operationId];
        if (prior) {
          if (prior.requestDigest !== prepared.operation.requestDigest)
            throw new Error('Source operation identity was reused with a different request');
          // Mutation publications always return their original SourcesPinResult on retry.
          return structuredClone(prior.result) as T;
        }
      }
      this.preparedPins(prepared);
      assertTarget();
      for (const lock of locks) this.assertCurrentLock(lock, prepared);
      const previous = this.state;
      const next = structuredClone(previous);
      next.pinRevision++;
      if (prepared.creationRunId) next.pendingRunCreations.push(prepared.creationRunId);
      for (const pin of prepared.pins)
        next.pins[JSON.stringify([pin.scope, pin.targetId, pin.sourceId])] = structuredClone(pin);
      for (const lock of locks) next.locks[JSON.stringify(lock.context)] = structuredClone(lock);
      if (prepared.operation)
        next.pinOperations[prepared.operation.result.operationId] = structuredClone(
          prepared.operation,
        );
      await this.persist(next, false);
      try {
        assertTarget();
        const result = publish();
        this.state = next;
        this.notify();
        return result;
      } catch (error) {
        await this.persist(previous);
        throw error;
      }
    });
  }

  /** Run rows load before source startup. Unfinished creation journals cannot leave effective orphan pins. */
  recoverRunCreations(hasRecordedRun: (runId: string) => boolean): Promise<void> {
    return this.serialize(async () => {
      if (!this.state.pendingRunCreations.length) return;
      const abandoned = new Set(
        this.state.pendingRunCreations.filter((runId) => !hasRecordedRun(runId)),
      );
      const next = structuredClone(this.state);
      for (const [key, pin] of Object.entries(next.pins)) {
        if (pin.scope === 'run' && abandoned.has(pin.targetId)) delete next.pins[key];
      }
      for (const [key, lock] of Object.entries(next.locks)) {
        if (lock.context.runId && abandoned.has(lock.context.runId)) delete next.locks[key];
      }
      next.pendingRunCreations = [];
      await this.persist(next);
    });
  }

  completeRunCreation(runId: string): Promise<void> {
    return this.serialize(async () => {
      if (!this.state.pendingRunCreations.includes(runId)) return;
      const next = structuredClone(this.state);
      next.pendingRunCreations = next.pendingRunCreations.filter((id) => id !== runId);
      await this.persist(next);
    });
  }

  affectedProjects(
    sourceId?: string,
    context: Pick<SourceLock['context'], 'nodeId' | 'runId'> = {},
    prepared?: PreparedSourcePins,
  ): string[] {
    if (sourceId && !this.configuration.sources.some((source) => source.id === sourceId))
      throw new Error(`Undeclared source: ${sourceId}`);
    const includes = (id: string, seen: Set<string>): boolean => {
      if (id === sourceId) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      const declaration = this.configuration.sources.find((source) => source.id === id);
      if (!declaration) return false;
      const effective = selectEffectiveSource(
        declaration,
        prepared ? this.preparedPins(prepared) : this.pins(),
        context,
      );
      const record = this.state.records[this.key(id, effective.effectiveRef)];
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

  private async persist(state: AuthorityState, publish = true): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const temporary = path.join(this.root, `authority.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
    await rename(temporary, path.join(this.root, 'authority.json'));
    if (publish) {
      this.state = state;
      this.notify();
    }
  }

  /** Called after each published write and each poll, so time-derived staleness is seen too. */
  observe(listener: () => void): () => void {
    this.observers.add(listener);
    return () => this.observers.delete(listener);
  }

  private notify(): void {
    for (const listener of this.observers) listener();
  }

  /** Each selected source/ref resolves independently. One failure does not stale unrelated records. */
  async reconcile(
    sourceIds = this.configuration.sources.map((source) => source.id),
  ): Promise<void> {
    await Promise.all(
      sourceIds.flatMap((id) => {
        const source = this.configuration.sources.find((source) => source.id === id);
        if (!source) throw new Error(`Undeclared source: ${id}`);
        const refs = new Set([
          source.ref ?? 'main',
          ...this.pins()
            .filter((pin) => pin.sourceId === id)
            .map((pin) => pin.ref),
        ]);
        return [...refs].map((ref) => this.reconcileSource(id, ref));
      }),
    );
  }

  /** Each effective ref polls independently. A pending fetch never accumulates duplicate work. */
  startReconciliation(onError: (sourceId: string, error: unknown) => void): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Set<string>();
    const poll = (): void => {
      if (stopped) return;
      for (const source of this.configuration.sources) {
        const refs = new Set([
          source.ref ?? 'main',
          ...this.pins()
            .filter((pin) => pin.sourceId === source.id)
            .map((pin) => pin.ref),
        ]);
        for (const ref of refs) {
          const key = this.key(source.id, ref);
          if (pending.has(key)) continue;
          pending.add(key);
          void this.reconcileSource(source.id, ref).then(
            () => {
              pending.delete(key);
            },
            (error: unknown) => {
              pending.delete(key);
              // Persistence failure remains visible; stale records refuse admission.
              onError(source.id, error);
            },
          );
        }
      }
      this.notify();
      timer = setTimeout(poll, this.configuration.pollIntervalMs);
      timer.unref();
    };
    poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }

  private reconcileSource(id: string, selectedRef?: string): Promise<void> {
    const source = this.configuration.sources.find((value) => value.id === id);
    if (!source) throw new Error(`Undeclared source: ${id}`);
    const repository = canonicalSourceRepo(source.repo);
    const previousFetch = this.resolving.get(repository) ?? Promise.resolve();
    const work = previousFetch.then(async () => {
      const next = structuredClone(this.state);
      const declaration = this.configuration.sources.find((source) => source.id === id);
      if (!declaration) throw new Error(`Undeclared source: ${id}`);
      const ref = selectedRef ?? declaration.ref ?? 'main';
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
        if (tree.refKind === 'tag' && previous?.tree && previous.tree.refObject !== tree.refObject)
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
          if (!isRecord(project))
            throw new Error(`Declared pack has no project.json: ${id}/${binding.entry}`);
          const portability = validatePackFilePortability(
            `${id}/${entry}`,
            JSON.stringify(project),
          );
          if (portability.length)
            throw new Error(`Declared pack is not portable:\n${portability.join('\n')}`);
          dependencies.push(...sourceDependencies(project));
          // These inherited prompts are pack inputs too. They must share this
          // closure instead of resolving another pack when dispatch starts.
          const sharedPack = this.configuration.packs['farmslot-farm'];
          if (
            sharedPack &&
            sharedPack.sourceId !== id &&
            [
              'templates/prompts/worker-dispatch.md',
              'templates/prompts/worker-nudge.md',
              'templates/worker/ci-fix.md',
            ].some(
              (entry) =>
                !tree.files.some((file) => file.path === path.posix.join(binding.entry, entry)),
            )
          )
            dependencies.push(sharedPack);
          const texts: string[] = [];
          const collect = (value: unknown): void => {
            if (typeof value === 'string') texts.push(value);
            else if (Array.isArray(value)) value.forEach(collect);
            else if (isRecord(value)) Object.values(value).forEach(collect);
          };
          collect(project);
          for (const text of texts) {
            for (const match of text.matchAll(
              /\{\{(?:farmslot_dir|FARMSLOT_DIR|node_support_dir|NODE_SUPPORT_DIR)\}\}\/projects\/([a-zA-Z0-9._-]+)/g,
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
            !tree.files.some((file) => file.path === binding.entry || file.path.startsWith(prefix))
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
      await this.serialize(async () => {
        const published = structuredClone(this.state);
        published.revision = this.configuration.revision;
        published.declarationDigest = sourceDigest(this.configuration);
        published.records[key] = next.records[key];
        await this.persist(published);
      });
    });
    this.resolving.set(
      repository,
      work.then(
        () => undefined,
        () => undefined,
      ),
    );
    return work;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.pending.then(operation);
    this.pending = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }

  /** Pin publication and admission share this boundary; preparation never seals stale inputs. */
  withCurrentLock<T>(lock: SourceLock, commit: () => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      this.assertCurrentLock(lock);
      return commit();
    });
  }

  private assertCurrentLock(lock: SourceLock, prepared?: PreparedSourcePins): void {
    const pins = prepared ? this.preparedPins(prepared) : this.pins();
    const pinRevision = this.state.pinRevision + (prepared ? 1 : 0);
    if (
      lock.declarationRevision !== this.configuration.revision ||
      lock.pinRevision !== pinRevision ||
      (!prepared && this.state.locks[JSON.stringify(lock.context)]?.digest !== lock.digest)
    )
      throw new GatewayMethodError('SOURCE_STATE_STALE', 'Source plan changed before admission');
    for (const entry of lock.entries) {
      const declaration = this.configuration.sources.find((source) => source.id === entry.sourceId);
      if (!declaration) throw new Error('Source declaration disappeared before admission');
      const effective = selectEffectiveSource(declaration, pins, lock.context);
      const record = this.state.records[this.key(entry.sourceId, effective.effectiveRef)];
      if (
        effective.effectiveRef !== entry.effectiveRef ||
        sourceDigest(effective.pin ?? null) !== sourceDigest(entry.pin ?? null) ||
        record?.resolution.status !== 'resolved' ||
        record.resolution.generation !== entry.resolutionGeneration ||
        record.tree?.commit !== entry.commit ||
        this.now() - Date.parse(record.resolution.resolvedAt ?? '') >
          this.configuration.pollIntervalMs * 2
      )
        throw new GatewayMethodError(
          'SOURCE_STATE_STALE',
          `Source plan is unavailable, changed or stale: ${entry.sourceId}`,
        );
    }
  }

  lock(context: SourceLock['context'], prepared?: PreparedSourcePins): Promise<SourceLock> {
    return this.serialize(async () => {
      const lock = this.composeLock(context, prepared);
      if (!prepared && this.state.locks[JSON.stringify(context)]?.digest !== lock.digest) {
        const next = structuredClone(this.state);
        next.locks[JSON.stringify(context)] = lock;
        await this.persist(next);
      }
      return structuredClone(lock);
    });
  }

  private composeLock(context: SourceLock['context'], prepared?: PreparedSourcePins): SourceLock {
    const pins = prepared ? this.preparedPins(prepared) : this.pins();
    const pinRevision = this.state.pinRevision + (prepared ? 1 : 0);
    const pack = this.configuration.packs[context.project];
    if (!pack) throw new Error(`No declared pack binding: ${context.project}`);
    const entries = new Map<string, SourceLockEntry>();
    const visit = (binding: SourceEntryRef, stack: string[]): void => {
      if (stack.includes(binding.sourceId)) throw new Error('Cyclic source dependencies');
      const declaration = this.configuration.sources.find(
        (source) => source.id === binding.sourceId,
      );
      if (!declaration) throw new Error(`Undeclared source: ${binding.sourceId}`);
      const effective = selectEffectiveSource(declaration, pins, context);
      if (effective.pin && effective.pin.declarationRevision !== this.configuration.revision)
        throw new Error(`Source pin belongs to a prior declaration: ${declaration.id}`);
      const ref = effective.effectiveRef;
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
        declaredRef: effective.declaredRef,
        effectiveRef: ref,
        commit: record.tree.commit,
        objectFormat: record.tree.objectFormat,
        treeDigest: record.tree.treeDigest,
        resolutionGeneration: record.resolution.generation,
        scope: effective.scope,
        ...(effective.pin ? { pin: effective.pin } : {}),
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
      previous.pinRevision === pinRevision &&
      sourceDigest(previous.entries) === sourceDigest(selected)
    )
      return structuredClone(previous);
    const content: Omit<SourceLock, 'digest'> = {
      schemaVersion: 1,
      context,
      generation: (this.state.locks[key]?.generation ?? 0) + 1,
      declarationRevision: this.configuration.revision,
      pinRevision,
      resolvedAt: new Date(this.now()).toISOString(),
      entries: selected,
      packBindings: Object.fromEntries(
        Object.entries(this.configuration.packs).filter(([, binding]) =>
          entries.has(binding.sourceId),
        ),
      ),
    };
    return { ...content, digest: sourceLockDigest(content) };
  }
}
