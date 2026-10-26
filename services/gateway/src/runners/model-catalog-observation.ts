import { homedir } from 'node:os';
import { join } from 'node:path';

import type {
  RunnerCatalogModel,
  RunnerModelCatalogResult,
  UpstreamObservation,
} from '@farmslot/protocol';

import {
  NativeCatalogPreferenceSource,
  NativeCatalogSourceUnavailable,
} from '../resources/native-catalog-changes.js';

import {
  queryRunnerModelCatalog,
  readRunnerModelCatalog,
  type RunnerModelCatalogSource,
} from './model-catalog.js';

export const RUNNER_MODEL_CATALOG_TTL_MS = 5 * 60_000;
export const RUNNER_MODEL_CATALOG_TICK_MS = 60_000;

export interface RunnerModelCatalogReadInterest {
  /** False once an admitted observer manages this connection's catalog reads. */
  legacyInterest?: boolean;
}

interface RunnerModelCatalogObservationOptions {
  /** Runners that declare a catalog capability. */
  runners(): string[];
  /** Existing source selection, including a configured pool path for command catalogs. */
  select(runner: string): Promise<RunnerModelCatalogSource | undefined>;
  hasInterest(runner: string): boolean;
  changed(runner: string): void;
  sample?(runner: string, source: RunnerModelCatalogSource): Promise<RunnerModelCatalogResult>;
  home?: string;
  now?: () => number;
}

interface CatalogSourceOwnerOptions {
  sample(): Promise<RunnerModelCatalogResult>;
  /** Structured files only: watched path and the read that detects an actual catalog change. */
  file?: { path: string; read(): RunnerModelCatalogResult };
  changed(): void;
  now(): number;
}

function catalogModel({
  id,
  label,
  reasoningModes,
  listed,
}: RunnerCatalogModel): RunnerCatalogModel {
  return {
    id,
    ...(label === undefined ? {} : { label }),
    reasoningModes: [...reasoningModes],
    listed,
  };
}

/** One owner per normalized source. Its clock is source success, never a client's read. */
class CatalogSourceOwner {
  selection = 0;
  private models: RunnerCatalogModel[] = [];
  private observedAt?: number;
  private attemptedAt?: number;
  private error?: string;
  private pending?: Promise<void>;
  private watcher?: NativeCatalogPreferenceSource;
  private published?: string;
  private stopped = false;

  constructor(
    readonly runner: string,
    readonly key: string,
    private readonly kind: 'structured-file' | 'catalog-command',
    private readonly options: CatalogSourceOwnerOptions,
  ) {}

  get observation(): UpstreamObservation {
    return {
      status: this.error
        ? this.observedAt === undefined
          ? 'error'
          : 'stale'
        : this.observedAt === undefined ||
            this.options.now() - this.observedAt >= RUNNER_MODEL_CATALOG_TTL_MS
          ? 'stale'
          : 'ready',
      ...(this.observedAt === undefined ? {} : { observedAt: this.observedAt }),
      ...(this.error
        ? { error: { code: 'RUNNER_MODEL_CATALOG_UNAVAILABLE', message: this.error } }
        : {}),
    };
  }

  snapshot(): RunnerModelCatalogResult {
    const detail =
      this.error ??
      (this.observedAt === undefined ? 'Runner model catalog has not been observed.' : undefined);
    return {
      runner: this.runner,
      status: detail ? 'unavailable' : 'ready',
      source: this.kind,
      ...(detail ? { detail } : {}),
      models: this.models.map(catalogModel),
      observation: this.observation,
    };
  }

  /** Legacy reads keep their former sample-per-read behavior. Managed warm reads never renew age. */
  async read(legacy: boolean): Promise<RunnerModelCatalogResult> {
    if (legacy || this.pending || this.attemptedAt === undefined) await this.refresh();
    return this.snapshot();
  }

  async tick(interested: boolean): Promise<void> {
    if (this.stopped) return;
    this.publish();
    if (!interested) {
      this.watcher?.close();
      this.watcher = undefined;
      return;
    }
    this.watch();
    if (
      this.attemptedAt === undefined ||
      this.options.now() - this.attemptedAt >= RUNNER_MODEL_CATALOG_TTL_MS
    )
      await this.refresh();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = undefined;
    await this.pending;
  }

  /** The existing watcher reattaches after replacement/removal and reports failure/recovery. */
  private watch(): void {
    const file = this.options.file;
    if (!file) return;
    this.watcher ??= new NativeCatalogPreferenceSource(
      file.path,
      () => JSON.stringify(file.read()),
      () => void this.refresh(),
    );
    try {
      this.watcher.sample();
    } catch (error) {
      // The failed sample already requested the refresh that records this source error.
      if (!(error instanceof NativeCatalogSourceUnavailable)) throw error;
    }
  }

  private refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.pending ??= (async () => {
      let result: RunnerModelCatalogResult;
      try {
        result = await this.options.sample();
      } catch (error) {
        // Raw failures can name catalog paths or carry runner output. Keep only an errno code.
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (typeof code !== 'string')
          console.error('[runner-models] Catalog sample failed:', error);
        const errno = typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? ` (${code})` : '';
        result = {
          runner: this.runner,
          status: 'unavailable',
          source: this.kind,
          detail: `Runner model catalog source failed${errno}.`,
          models: [],
        };
      }
      // A stopped or superseded source never retains or publishes its late reply.
      if (this.stopped) return;
      this.attemptedAt = this.options.now();
      if (result.status === 'ready') {
        this.models = result.models.map(catalogModel);
        this.observedAt = this.attemptedAt;
        this.error = undefined;
      } else this.error = result.detail || 'Runner model catalog is unavailable.';
      this.publish();
    })().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private publish(): void {
    if (this.stopped || this.attemptedAt === undefined) return;
    const signature = JSON.stringify(this.snapshot());
    if (signature === this.published) return;
    this.published = signature;
    this.options.changed();
  }
}

/** Bounded to one current owner per catalog runner. Only admitted demand selects or samples. */
export class RunnerModelCatalogObservation {
  private readonly owners = new Map<string, CatalogSourceOwner>();
  private readonly retired = new Set<Promise<void>>();
  private selections = 0;
  private stopped = false;
  private readonly home: string;
  private readonly now: () => number;

  constructor(private readonly options: RunnerModelCatalogObservationOptions) {
    this.home = options.home ?? homedir();
    this.now = options.now ?? Date.now;
  }

  async read(
    runner: string,
    interest: RunnerModelCatalogReadInterest = {},
  ): Promise<RunnerModelCatalogResult> {
    const legacy = interest.legacyInterest !== false;
    if (this.stopped)
      return (
        this.owners.get(runner)?.snapshot() ?? {
          runner,
          status: 'unavailable',
          source: 'unavailable',
          detail: 'Runner model catalog collection is stopped.',
          models: [],
          observation: { status: 'stale' },
        }
      );
    const owner = await this.owner(runner);
    if (!owner) return readRunnerModelCatalog(runner, undefined);
    const result = await owner.read(legacy);
    // A source change while sampling fences that reply; answer from the current source.
    const current = this.owners.get(runner);
    if (current === owner || this.stopped) return result;
    return current ? current.read(legacy) : readRunnerModelCatalog(runner, undefined);
  }

  start(): void {
    if (this.stopped) this.owners.clear();
    this.stopped = false;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all([...[...this.owners.values()].map((owner) => owner.stop()), ...this.retired]);
  }

  /** Called by the slow scheduler or a changed observer set. No interest stops passive work. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    await Promise.all(
      this.options.runners().map(async (runner) => {
        if (!this.options.hasInterest(runner)) return this.owners.get(runner)?.tick(false);
        let owner: CatalogSourceOwner | undefined;
        try {
          owner = await this.owner(runner);
        } catch (error) {
          // Reads surface selection failures. Passive ticks keep the retained observation.
          console.error(`[runner-models] Catalog source selection failed for ${runner}:`, error);
          return;
        }
        if (!this.stopped) await owner?.tick(true);
      }),
    );
  }

  private async owner(runner: string): Promise<CatalogSourceOwner | undefined> {
    const selection = ++this.selections;
    const source = await this.options.select(runner);
    const current = this.owners.get(runner);
    // An older selection that resolves late cannot replace a newer one.
    if (this.stopped || (current && current.selection > selection)) return current;
    const key = source
      ? JSON.stringify(
          'command' in source
            ? [runner, 'command', source.command, source.args]
            : [runner, 'file', join(this.home, source.relativePath)],
        )
      : undefined;
    if (current && current.key === key) {
      current.selection = selection;
      return current;
    }
    if (current) {
      const drained = current.stop();
      this.retired.add(drained);
      void drained.finally(() => this.retired.delete(drained));
      this.owners.delete(runner);
    }
    if (!source || !key) return undefined;
    const sample = this.options.sample;
    const next = new CatalogSourceOwner(
      runner,
      key,
      'command' in source ? 'catalog-command' : 'structured-file',
      {
        sample: () =>
          sample
            ? sample(runner, source)
            : 'command' in source
              ? queryRunnerModelCatalog(runner, source)
              : Promise.resolve(readRunnerModelCatalog(runner, source, this.home)),
        ...('command' in source
          ? {}
          : {
              file: {
                path: join(this.home, source.relativePath),
                read: () => readRunnerModelCatalog(runner, source, this.home),
              },
            }),
        changed: () => this.options.changed(runner),
        now: this.now,
      },
    );
    next.selection = selection;
    this.owners.set(runner, next);
    return next;
  }
}
