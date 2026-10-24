import { realpath } from 'node:fs/promises';

import { expandTilde } from '@farmslot/capabilities/fs-watch';
import { armLocalWorkspace } from '@farmslot/capabilities/workspace-watch';
import {
  canonicalResourceJson,
  type ResourceKey,
  resourceKeyId,
} from '@farmslot/protocol/client-cache';

import { GatewayMethodError } from '../core/method-error.js';

import { resourceRevisions } from './revisions.js';

export interface WorkspaceBinding {
  /** Server-resolved physical source; never taken from a client owner/path key. */
  root: string;
  sourceId: string;
  keys: ResourceKey[];
  /** Recheck slot/run/context/lease/profile and node authority, including after I/O. */
  current(): Promise<boolean>;
  arm?(changed: () => void, failed: (error: Error) => void): Promise<() => void>;
}
export interface WorkspaceWatch {
  close(): void;
}

export { armLocalWorkspace } from '@farmslot/capabilities/workspace-watch';

interface Source {
  binding: WorkspaceBinding;
  keys: Map<string, ResourceKey>;
  revision: number;
  armed?: boolean;
  failure?: Error;
  stop?: () => void;
  arming?: Promise<void>;
  released?: boolean;
}

/** One source per resolved workspace, shared by every panel/query and existing source writers. */
export class WorkspaceObservations {
  private sources = new Map<string, Source>();
  constructor(
    private publish: (key: ResourceKey) => void = (key) => resourceRevisions.advance(key),
  ) {}
  async capture(binding: WorkspaceBinding): Promise<() => Promise<void>> {
    if (!binding.arm) {
      const root = await realpath(expandTilde(binding.root));
      binding = { ...binding, root, sourceId: workspaceSourceId('local', root) };
    }
    try {
      if (!(await binding.current()))
        throw this.unavailable('Workspace identity is no longer current');
    } catch (error) {
      this.release(binding.sourceId);
      throw error;
    }
    let source = this.sources.get(binding.sourceId);
    if (source) {
      let current: boolean;
      try {
        current = await source.binding.current();
      } catch (error) {
        this.release(binding.sourceId);
        throw error;
      }
      if (this.sources.get(binding.sourceId) !== source) return this.capture(binding);
      if (!current) {
        this.release(binding.sourceId);
        source = undefined;
      }
    }
    if (source?.failure) {
      source.stop?.();
      this.sources.delete(binding.sourceId);
      source = undefined;
    }
    if (!source) {
      if (this.sources.size >= 128) this.release(this.sources.keys().next().value!);
      source = { binding, keys: new Map(), revision: 0 };
      this.sources.set(binding.sourceId, source);
      const owned = source;
      const change = () => {
        if (owned.released || owned.failure || this.sources.get(binding.sourceId) !== owned) return;
        owned.revision++;
        for (const key of owned.keys.values()) this.publish(key);
      };
      const fail = (error: Error) => {
        if (owned.released || owned.failure) return;
        const wasArmed = owned.armed;
        owned.failure = error;
        owned.armed = false;
        owned.revision++;
        const stop = owned.stop;
        owned.stop = undefined;
        stop?.();
        if (wasArmed) for (const key of owned.keys.values()) this.publish(key);
      };
      owned.arming = (async () => {
        try {
          const stop = await (
            binding.arm ?? ((changed, failed) => armLocalWorkspace(binding.root, changed, failed))
          )(change, fail);
          if (owned.released || owned.failure || this.sources.get(binding.sourceId) !== owned)
            stop();
          else {
            owned.stop = stop;
            owned.armed = true;
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    }
    for (const key of binding.keys) source.keys.set(resourceKeyId(key), key);
    await source.arming;
    if (this.sources.get(binding.sourceId) !== source)
      throw this.unavailable('Workspace source replaced while arming');
    if (source.failure) {
      if (
        source.failure instanceof GatewayMethodError &&
        source.failure.code === 'RESOURCE_OBSERVATION_UNSUPPORTED'
      )
        throw source.failure;
      throw this.unavailable(source.failure.message);
    }
    const revision = source.revision;
    const captured = source;
    return async () => {
      if (this.sources.get(binding.sourceId) !== captured || captured.failure)
        throw this.unavailable('Workspace source or identity changed during the read');
      try {
        if (!(await binding.current()))
          throw this.unavailable('Workspace source or identity changed during the read');
      } catch (error) {
        this.release(binding.sourceId);
        throw error;
      }
      if (captured.revision !== revision)
        throw this.unavailable('Workspace source or identity changed during the read');
    };
  }
  /** Explicit source teardown and bounded registry eviction revoke every derived workspace key. */
  release(sourceId: string) {
    const source = this.sources.get(sourceId);
    this.sources.delete(sourceId);
    if (!source) return;
    source.released = true;
    source.armed = false;
    source.revision++;
    const stop = source.stop;
    source.stop = undefined;
    stop?.();
    for (const key of source.keys.values()) this.publish(key);
    // Pending arm completion observes released and closes its own handle.
  }
  dispose(): void {
    for (const id of this.sources.keys()) this.release(id);
  }
  /** Reuse existing fs/git writer receipts; native external writers arrive from the source watch. */
  changed(sourceId: string) {
    const source = this.sources.get(sourceId);
    if (source) {
      source.revision++;
      for (const key of source.keys.values()) this.publish(key);
    }
  }
  private unavailable(message: string) {
    return new GatewayMethodError('RESOURCE_OBSERVATION_UNAVAILABLE', message);
  }
}
export const workspaceObservations = new WorkspaceObservations();
export function workspaceSourceId(nodeId: string, root: string): string {
  // Watch coverage is physical; per-read bindings retain exact principal/profile/lease authority.
  return canonicalResourceJson([nodeId, root]);
}
