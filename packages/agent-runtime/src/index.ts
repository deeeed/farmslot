export const AGENT_RUNTIME_PACKAGE = '@farmslot/agent-runtime';

export const AGENT_RUNTIME_SCRIPT_EXPORTS = {
  markChecklistStep: '@farmslot/agent-runtime/scripts/mark-checklist-step.cjs',
  workerTerminalContract: '@farmslot/agent-runtime/scripts/worker-terminal-contract.cjs',
  checkTaskArtifactContract: '@farmslot/agent-runtime/scripts/check-task-artifact-contract.mjs',
} as const;

export * from './recipe-quality.js';
