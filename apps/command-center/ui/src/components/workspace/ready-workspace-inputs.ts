import type { ReadyGateInputSnapshot, ReadyGatePayload, Run } from '@farmslot/protocol';

export interface ReadyInputArtifact {
  id: string;
  label: string;
  kind: string;
  summary: string;
  format: 'markdown' | 'text' | 'json';
  body: string;
  meta?: string[];
}

export interface ReadyInputArtifactState {
  legacyTaskPromptText: string;
  legacyTaskPromptLoading: boolean;
  legacyTaskPromptError: string;
}

export function readyWorkspaceQualityItemCount(payload: ReadyGatePayload): number {
  return (
    payload.recipeQualityArtifact?.compact.reasons.length ||
    payload.qualityReport?.acVerdicts.length ||
    payload.acceptanceCriteria?.length ||
    0
  );
}

export function readyWorkspaceInputSnapshot(
  payload: ReadyGatePayload,
  run: Run | null,
): ReadyGateInputSnapshot | null {
  if (payload.inputSnapshot) return payload.inputSnapshot;
  if (!run) return null;
  const input: ReadyGateInputSnapshot = {
    ...(run.ticketData ? { ticketData: run.ticketData } : {}),
    taskFile: run.taskFile,
    ...(run.engineState?.interactiveDev?.initialContext
      ? { initialContext: run.engineState.interactiveDev.initialContext }
      : {}),
    ...(run.engineState?.interactiveDev?.checklist?.length
      ? { checklist: run.engineState.interactiveDev.checklist }
      : {}),
    ...(run.templateProvenance ? { templateProvenance: run.templateProvenance } : {}),
  };
  return input.ticketData ||
    input.taskFile ||
    input.initialContext ||
    input.checklist?.length ||
    input.templateProvenance
    ? input
    : null;
}

export function readyWorkspaceInputItemCount(
  payload: ReadyGatePayload,
  run: Run | null,
  state: ReadyInputArtifactState,
): number {
  return readyWorkspaceInputArtifacts(payload, run, state).length;
}

export function readyWorkspaceTicketInputMarkdown(
  ticket: NonNullable<ReadyGateInputSnapshot['ticketData']>,
): string {
  const lines: string[] = [`# ${ticket.title || ticket.jiraKey || ticket.githubIssue || 'Input'}`];
  if (ticket.jiraKey) lines.push('', `Jira: ${ticket.jiraKey}`);
  if (ticket.githubIssue) lines.push('', `GitHub: ${ticket.githubIssue}`);
  if (ticket.issueType) lines.push('', `Type: ${ticket.issueType}`);
  if (ticket.affectedArea) lines.push('', `Affected area: ${ticket.affectedArea}`);
  if ((ticket.labels ?? []).length) lines.push('', `Labels: ${(ticket.labels ?? []).join(', ')}`);
  if (ticket.description) lines.push('', '## Description', '', ticket.description);
  if ((ticket.acceptanceCriteria ?? []).length) {
    lines.push('', '## Acceptance criteria', '');
    lines.push(...(ticket.acceptanceCriteria ?? []).map((criterion) => `- ${criterion}`));
  }
  if ((ticket.stepsToReproduce ?? []).length) {
    lines.push('', '## Steps to reproduce', '');
    lines.push(...(ticket.stepsToReproduce ?? []).map((step, index) => `${index + 1}. ${step}`));
  }
  if (ticket.linkedTickets?.length) {
    lines.push('', '## Linked tickets', '');
    lines.push(
      ...ticket.linkedTickets.map((linked) => `- [${linked.ref}](${linked.url}) ${linked.title}`),
    );
  }
  return lines.join('\n');
}

export function readyWorkspaceInputArtifacts(
  payload: ReadyGatePayload,
  run: Run | null,
  state: ReadyInputArtifactState,
): ReadyInputArtifact[] {
  const input = readyWorkspaceInputSnapshot(payload, run);
  if (!input) return [];
  const artifacts: ReadyInputArtifact[] = [];
  const ticket = input.ticketData;
  if (ticket) {
    artifacts.push({
      id: 'ticket',
      label: ticket.jiraKey ?? ticket.githubIssue ?? 'Original ticket',
      kind:
        ticket.source === 'jira' || ticket.source === 'both'
          ? 'Jira'
          : ticket.source === 'github'
            ? 'GitHub'
            : 'Manual',
      summary: ticket.title || ticket.description.slice(0, 120) || 'Original work item input',
      format: 'markdown',
      body: readyWorkspaceTicketInputMarkdown(ticket),
      meta: [
        ticket.issueType,
        ...(ticket.acceptanceCriteria?.length ? [`${ticket.acceptanceCriteria.length} AC`] : []),
        ...(ticket.comments?.length ? [`${ticket.comments.length} comments`] : []),
      ].filter((item): item is string => Boolean(item)),
    });
    if (ticket.comments?.length) {
      artifacts.push({
        id: 'ticket-comments',
        label: 'Ticket comments',
        kind: 'Comments',
        summary: `${ticket.comments.length} comments supplied with the task input`,
        format: 'text',
        body: ticket.comments.join('\n\n---\n\n'),
        meta: [`${ticket.comments.length} entries`],
      });
    }
  }
  if (input.initialContext) {
    artifacts.push({
      id: 'initial-context',
      label: 'Operator prompt',
      kind: 'Prompt',
      summary: input.initialContext.slice(0, 140),
      format: 'text',
      body: input.initialContext,
    });
  }
  if (input.checklist?.length) {
    artifacts.push({
      id: 'checklist',
      label: 'Dispatch checklist',
      kind: 'Checklist',
      summary: `${input.checklist.length} checklist items`,
      format: 'markdown',
      body: input.checklist.map((item) => `- ${item}`).join('\n'),
      meta: [`${input.checklist.length} items`],
    });
  }
  if (input.taskPrompt) {
    artifacts.push({
      id: 'task-prompt',
      label: 'TASK.md prompt',
      kind: 'Task',
      summary: input.taskFile ?? 'Rendered task prompt delivered to the worker',
      format: 'text',
      body: input.taskPrompt,
      meta: input.taskFile ? [input.taskFile] : undefined,
    });
  } else if (input.taskFile) {
    artifacts.push({
      id: 'task-prompt',
      label: 'TASK.md prompt',
      kind: 'Task',
      summary: state.legacyTaskPromptText
        ? 'Rendered task prompt delivered to the worker'
        : 'Open to load the rendered task prompt',
      format: 'text',
      body:
        state.legacyTaskPromptText ||
        (state.legacyTaskPromptError
          ? `Failed to load TASK.md: ${state.legacyTaskPromptError}`
          : state.legacyTaskPromptLoading
            ? 'Loading TASK.md…'
            : 'Open this artifact to load TASK.md.'),
      meta: [input.taskFile],
    });
  }
  if (input.templateProvenance) {
    artifacts.push({
      id: 'template-provenance',
      label: 'Template provenance',
      kind: 'Template',
      summary: `${input.templateProvenance.templateName} · ${input.templateProvenance.contentHash.slice(0, 12)}`,
      format: 'json',
      body: JSON.stringify(input.templateProvenance, null, 2),
      meta: [input.templateProvenance.source, input.templateProvenance.flowType],
    });
  }
  return artifacts;
}
