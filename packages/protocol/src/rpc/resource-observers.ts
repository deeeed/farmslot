import type { ResourceCollectorReadMethod } from '../client-cache/registry.js';

/** Source success age is distinct from the time a client reads the gateway's retained value. */
export interface UpstreamObservation {
  status: 'ready' | 'stale' | 'error';
  observedAt?: number;
  error?: { code: string; message: string };
}

/** Experimental connection-bound collector admission, on the existing websocket. */
export interface ResourceObserversCapability {
  version: 1;
  methods: ResourceCollectorReadMethod[];
}

export interface ResourceObserverQuery {
  method: ResourceCollectorReadMethod;
  params?: unknown;
}

export interface ResourceObserversReplaceParams {
  version: 1;
  /** Strictly increasing within one websocket, including removals and empty replacements. */
  sequence: number;
  queries: ResourceObserverQuery[];
}

export interface ResourceObserversReplaceResult {
  version: 1;
  sequence: number;
  /** False when a later replacement or disconnect already superseded this request. */
  applied: boolean;
}
