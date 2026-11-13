import { modelQuestionsOffByRunner } from './model-questions.js';

/** Headless turns cannot leave work waiting for a notification after they return. */
export function claudeHeadlessEnvironment(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...base,
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    // MCP tasks are separate from automatic tool-call backgrounding, including in stream-json.
    CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND: '1',
  };
}

// The background-task switch excludes Monitor. Remove that tool as well.
// https://code.claude.com/docs/en/env-vars#variables
export function claudeHeadlessDisallowedTools(modelQuestions?: 'off'): string[] {
  return [
    'Monitor',
    ...(modelQuestions === 'off' ? modelQuestionsOffByRunner.claude.args.slice(1) : []),
  ];
}
