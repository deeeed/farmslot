export interface ModelQuestionsSwitch {
  args?: readonly string[];
  environment?: Readonly<Record<string, string>>;
}

/** OpenCode's permission rule that removes its `question` tool. */
export const opencodeQuestionPermission = { question: 'deny' } as const;

/**
 * Launch switches, by runner, that remove only the model's own ask-the-operator tool, for runs
 * no operator watches. Operator input (terminal send, native steer, queued follow-ups) never
 * goes through that tool and keeps working. Pi has no such tool; Cursor has no switch.
 * Both the native and the terminal (tmux) launches read this table.
 */
export const modelQuestionsOffByRunner: Readonly<Record<string, ModelQuestionsSwitch>> = {
  // Variadic: another option must follow, or a prompt after it is read as a tool name.
  claude: { args: ['--disallowedTools', 'AskUserQuestion'] },
  // A TOML struct; Codex rejects a bare boolean. A root option, so it may precede a subcommand.
  codex: { args: ['--config', 'tools.experimental_request_user_input={enabled=false}'] },
  grok: { environment: { GROK_ASK_USER_QUESTION: '0' } },
  // Merges with the project's own permission rules.
  opencode: { environment: { OPENCODE_PERMISSION: JSON.stringify(opencodeQuestionPermission) } },
};
