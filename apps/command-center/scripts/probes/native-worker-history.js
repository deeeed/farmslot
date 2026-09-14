const walk = (root) =>
  [...root.querySelectorAll('*')].flatMap((element) =>
    element.shadowRoot ? [element, ...walk(element.shadowRoot)] : [element],
  );
const all = walk(document);
const view = all.find((element) => element.matches('native-session-view'));
const root = view?.shadowRoot;
return {
  runId: view?.worker?.runId,
  contextId: view?.worker?.contextId,
  sessionId: view?.worker?.binding.sessionId,
  executionNodeId: view?.worker?.binding.executionNodeId,
  leaseId: view?.worker?.binding.leaseId,
  generation: view?.worker?.binding.generation,
  status: root?.querySelector('.status[data-state]')?.textContent.trim(),
  inputDisabled: root?.querySelector('textarea')?.disabled,
  sendDisabled: root?.querySelector('[data-testid=native-send]')?.disabled,
  stopDisabled: root?.querySelector('[data-testid=native-stop]')?.disabled,
  closeDisabled: root?.querySelector('[data-testid=native-close]')?.disabled ?? true,
  workspaceToggle: Boolean(root?.querySelector('[data-testid=native-workspace-toggle]')),
  workspaceMounted: Boolean(root?.querySelector('native-workspace')),
  pending: root?.querySelectorAll('[data-request-id]').length ?? 0,
  entries: [...(root?.querySelectorAll('.timeline article[data-sequence]') ?? [])].map(
    (element) => ({
      sequence: Number(element.getAttribute('data-sequence')),
      text: element.textContent.trim(),
    }),
  ),
  errors: [...(root?.querySelectorAll('[role=alert]') ?? [])].map((element) =>
    element.textContent.trim(),
  ),
};
