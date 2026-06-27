import { normalizeInstructionText } from './digest.mjs';

// Keep in sync with services/gateway/src/runners/registry.ts detectRunnerLaunchBlocker.
export function runnerPaneShowsWorkspaceTrustPrompt(pane, runnerId) {
  if (runnerId !== 'cursor') return false;
  const value = normalizeInstructionText(pane).toLowerCase();
  return (
    value.includes('[a] trust this workspace') &&
    value.includes('[q] quit') &&
    value.includes('use arrow keys to navigate')
  );
}

export function runnerPaneShowsGrokProjectDirectoryPrompt(pane, runnerId) {
  if (runnerId !== 'grok') return false;
  const value = normalizeInstructionText(pane).toLowerCase();
  return (
    value.includes('run grok build in a project directory') &&
    value.includes('(current)') &&
    value.includes('enter:submit')
  );
}

export function detectLaunchBlocker(pane, runnerId) {
  if (runnerPaneShowsWorkspaceTrustPrompt(pane, runnerId)) {
    return { kind: 'workspace-trust', autoAction: 'cursor-trust-workspace' };
  }
  if (runnerPaneShowsGrokProjectDirectoryPrompt(pane, runnerId)) {
    return { kind: 'project-directory', autoAction: 'grok-select-current-project' };
  }
  return null;
}