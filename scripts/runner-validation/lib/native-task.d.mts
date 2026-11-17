export function fixtureChecklistPath(cwd: string, taskFile: string): string;
export function writeNativeFixtureTask(
  taskFile: string,
  checklistMarkdown: string,
  project: string,
  options?: {
    claimReviewGate?: boolean;
    description?: string;
    markCommand?: string;
  },
): Promise<string>;
