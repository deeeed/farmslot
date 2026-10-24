import type { NodeTmuxPane } from '../rpc/tmux.js';

/** Experimental producer versions. Absent fields never imply observation support. */
export interface NodeObservationCapabilities {
  workers?: 1;
  files?: 1;
  workspace?: 1;
}

export type NodeTmuxWorkerObservation =
  | { status: 'ready'; observedAt: number; panes: NodeTmuxPane[] }
  | { status: 'unavailable'; observedAt: number; error: { code: string; message: string } };

/** Marks cache reads at dispatch, independently of domain parameters and imperative commands. */
export interface ResourceReadContext {
  version: 1;
}
