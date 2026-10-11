// runner-mobile-keys.ts — extra phone terminal keys per runner. The gateway
// runner registry references each profile from its RunnerDefinition; Companion
// looks a profile up by runner id. Each key records the CLI build and the
// documented binding it was read from. Exec-only runners have no profile; an
// interactive runner with no documented extra keys has an empty one.
//
// Inventoried on macpro, 2026-10-10. References are relative to each CLI's
// installed package. Chords that tmux cannot pass distinctly (Ctrl+I, Ctrl+M,
// Shift+Enter), a default tmux prefix (Ctrl+B), double Esc sent as one write,
// and destructive chords are left out.

import { normalizeRunner } from './runner-ids.js';

export interface RunnerMobileKeySource {
  /** Output of `<cli> --version` on the machine the binding was checked on. */
  cliVersion: string;
  /** Where the CLI documents the binding: a file in its installed package, or a help command. */
  reference: string;
}

export interface RunnerMobileKey {
  /** Action label. Stays distinct when `data` matches another key's bytes, such as Esc. */
  label: string;
  /** Bytes written to the pane. */
  data: string;
  danger: boolean;
  /** Chord as the CLI documents it. */
  chord: string;
  source: RunnerMobileKeySource;
}

export interface RunnerMobileKeyProfile {
  runnerId: string;
  /** Runner name shown on the row and in the picker. */
  label: string;
  /** CLI build and sources checked, recorded even when they yielded no keys. */
  inventory: RunnerMobileKeySource;
  keys: readonly RunnerMobileKey[];
}

const CLAUDE = 'claude 2.1.296';
const CLAUDE_KEYMAP = 'default keymap in the @anthropic-ai/claude-code-darwin-arm64 claude binary';
const CODEX = 'codex-cli 0.162.1';
const CURSOR = 'cursor-agent 2026.09.28-64d2043';
const CURSOR_BUNDLE = 'versions/2026.09.28-64d2043/6949.index.js';
const GROK = 'grok 1.0.50';
const GROK_DOC = '~/.grok/docs/user-guide/03-keyboard-shortcuts.md';
const PI = 'pi 0.87.0';
const PI_DOC = '@earendil-works/pi-coding-agent/docs/keybindings.md';

export const RUNNER_MOBILE_KEY_PROFILES = {
  claude: {
    runnerId: 'claude',
    label: 'Claude Code',
    inventory: { cliVersion: CLAUDE, reference: `README.md (no key list); ${CLAUDE_KEYMAP}` },
    keys: [
      {
        label: 'Transcript',
        data: '\x0f',
        danger: false,
        chord: 'Ctrl+O',
        source: {
          cliVersion: CLAUDE,
          reference: `${CLAUDE_KEYMAP}: "ctrl+o":"app:toggleTranscript"`,
        },
      },
      {
        label: 'History',
        data: '\x12',
        danger: false,
        chord: 'Ctrl+R',
        source: { cliVersion: CLAUDE, reference: `${CLAUDE_KEYMAP}: "ctrl+r":"history:search"` },
      },
      {
        label: 'Model',
        data: '\x1bp',
        danger: false,
        chord: 'Meta+P',
        source: { cliVersion: CLAUDE, reference: `${CLAUDE_KEYMAP}: "meta+p":"chat:modelPicker"` },
      },
    ],
  },
  codex: {
    runnerId: 'codex',
    label: 'Codex',
    // The seeded skip keys (Left, Shift+Left, Ctrl+[) are not mapped by any of these sources.
    inventory: {
      cliVersion: CODEX,
      reference:
        'README.md, `codex --help`, `codex debug --help` and the app-server JSON schema; none lists key bindings',
    },
    keys: [],
  },
  cursor: {
    runnerId: 'cursor',
    label: 'Cursor Agent',
    inventory: {
      cliVersion: CURSOR,
      reference: `\`cursor-agent --help\` (no key list); ${CURSOR_BUNDLE}`,
    },
    keys: [
      {
        label: 'Expand',
        data: '\x0f',
        danger: false,
        chord: 'Ctrl+O',
        source: { cliVersion: CURSOR, reference: `${CURSOR_BUNDLE}: "ctrl+o to expand"` },
      },
      {
        label: 'Review',
        data: '\x12',
        danger: false,
        chord: 'Ctrl+R',
        source: {
          cliVersion: CURSOR,
          reference: `${CURSOR_BUNDLE}: "ctrl+r to review changed files"`,
        },
      },
      {
        label: 'Newline',
        data: '\n',
        danger: false,
        chord: 'Ctrl+J',
        source: { cliVersion: CURSOR, reference: `${CURSOR_BUNDLE}: "Ctrl+J for newlines"` },
      },
      {
        // Same byte as the generic Esc key; kept for the question-skip action it names.
        label: 'Skip',
        data: '\x1b',
        danger: false,
        chord: 'Esc',
        source: { cliVersion: CURSOR, reference: `${CURSOR_BUNDLE}: "Esc to skip"` },
      },
    ],
  },
  grok: {
    runnerId: 'grok',
    label: 'Grok',
    inventory: { cliVersion: GROK, reference: GROK_DOC },
    keys: [
      {
        label: 'Palette',
        data: '\x10',
        danger: false,
        chord: 'Ctrl+P',
        source: { cliVersion: GROK, reference: `${GROK_DOC}:247` },
      },
      {
        label: 'Sessions',
        data: '\x12',
        danger: false,
        chord: 'Ctrl+R',
        source: { cliVersion: GROK, reference: `${GROK_DOC}:253` },
      },
      {
        label: 'Tasks',
        data: '\x07',
        danger: false,
        chord: 'Ctrl+G',
        source: { cliVersion: GROK, reference: `${GROK_DOC}:258` },
      },
      {
        label: 'Prev turn',
        data: '\x1b[1;2D',
        danger: false,
        chord: 'Shift+Left',
        source: { cliVersion: GROK, reference: `${GROK_DOC}:36 (scrollback focused)` },
      },
      {
        label: 'Next turn',
        data: '\x1b[1;2C',
        danger: false,
        chord: 'Shift+Right',
        source: { cliVersion: GROK, reference: `${GROK_DOC}:35 (scrollback focused)` },
      },
    ],
  },
  pi: {
    runnerId: 'pi',
    label: 'Pi',
    inventory: { cliVersion: PI, reference: PI_DOC },
    keys: [
      {
        label: 'Tools',
        data: '\x0f',
        danger: false,
        chord: 'Ctrl+O',
        source: { cliVersion: PI, reference: `${PI_DOC}:163 app.tools.expand` },
      },
      {
        label: 'Thinking',
        data: '\x14',
        danger: false,
        chord: 'Ctrl+T',
        source: { cliVersion: PI, reference: `${PI_DOC}:157 app.thinking.toggle` },
      },
      {
        label: 'Follow-up',
        data: '\x1b\r',
        danger: false,
        chord: 'Alt+Enter',
        source: { cliVersion: PI, reference: `${PI_DOC}:165 app.message.followUp` },
      },
      {
        label: 'Dequeue',
        data: '\x1b[1;3A',
        danger: false,
        chord: 'Alt+Up',
        source: { cliVersion: PI, reference: `${PI_DOC}:166 app.message.dequeue` },
      },
    ],
  },
} as const satisfies Record<string, RunnerMobileKeyProfile>;

const PROFILES_BY_RUNNER = new Map<string, RunnerMobileKeyProfile>(
  Object.values(RUNNER_MOBILE_KEY_PROFILES).map((profile) => [profile.runnerId, profile]),
);

export function runnerMobileKeyProfile(runnerId?: string | null): RunnerMobileKeyProfile | null {
  if (!runnerId?.trim()) return null;
  return PROFILES_BY_RUNNER.get(normalizeRunner(runnerId)) ?? null;
}
