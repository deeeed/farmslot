export interface ExecutionTemplateStepPreview {
  checked: boolean;
  text: string;
}

export interface ExecutionTemplatePhasePreview {
  title: string;
  steps: ExecutionTemplateStepPreview[];
}

export interface ExecutionTemplateOutline {
  phases: ExecutionTemplatePhasePreview[];
  totalSteps: number;
  checkedSteps: number;
}

export function executionTemplateStepLabel(markdown: string): string {
  return markdown
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1');
}

export function parseExecutionTemplateOutline(markdown: string): ExecutionTemplateOutline {
  const phases: ExecutionTemplatePhasePreview[] = [];
  let current: ExecutionTemplatePhasePreview | undefined;
  let checkedSteps = 0;

  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = { title: heading[1], steps: [] };
      phases.push(current);
      continue;
    }

    const checkbox = /^\s*[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/.exec(line);
    if (!checkbox) continue;
    if (!current) {
      current = { title: 'Steps', steps: [] };
      phases.push(current);
    }
    const checked = checkbox[1].toLowerCase() === 'x';
    current.steps.push({ checked, text: executionTemplateStepLabel(checkbox[2]) });
    if (checked) checkedSteps++;
  }

  const populatedPhases = phases.filter((phase) => phase.steps.length > 0);
  return {
    phases: populatedPhases,
    totalSteps: populatedPhases.reduce((total, phase) => total + phase.steps.length, 0),
    checkedSteps,
  };
}
