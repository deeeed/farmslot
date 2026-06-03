import type { FlowType } from '@farmslot/protocol';

import type { FlowMode } from '../flow-graph/flow-graph-data.js';

export type ConfigPanelSelection =
  | { kind: 'pool'; machine: string }
  | { kind: 'project'; name: string }
  | { kind: 'flows' }
  | { kind: 'llm' };

export interface ConfigPanelFlowsState {
  flowType: FlowType;
  mode: FlowMode;
  laneMode: string;
  project: string;
}

export interface ConfigPanelRouteState {
  selection: ConfigPanelSelection;
  flowsState?: ConfigPanelFlowsState;
}

export function parseConfigPanelRoute(path: string): ConfigPanelRouteState | null {
  if (!path) return null;
  if (path === 'flows' || path.startsWith('flows/')) {
    const parts = path.split('/');
    return {
      selection: { kind: 'flows' },
      flowsState:
        parts.length > 1
          ? {
              flowType: (parts[1] || 'fix-bug') as FlowType,
              mode: (parts[2] || 'interactive') as FlowMode,
              laneMode: parts[3] || 'phase',
              project: parts[4] || '',
            }
          : undefined,
    };
  }
  if (path.startsWith('project/')) return { selection: { kind: 'project', name: path.slice(8) } };
  if (path.startsWith('pool/')) return { selection: { kind: 'pool', machine: path.slice(5) } };
  if (path === 'llm') return { selection: { kind: 'llm' } };
  return { selection: { kind: 'pool', machine: path } }; // backward compat: bare machine name
}

export function formatConfigPanelRoute(
  selection: ConfigPanelSelection,
  flowsState: ConfigPanelFlowsState,
): string {
  if (selection.kind === 'flows') {
    const { flowType, mode, laneMode, project } = flowsState;
    return `flows/${flowType}/${mode}/${laneMode}${project ? '/' + project : ''}`;
  }
  if (selection.kind === 'pool') return `pool/${selection.machine}`;
  if (selection.kind === 'project') return `project/${selection.name}`;
  return 'llm';
}
