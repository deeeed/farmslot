// Shared header controls for diff file lists: the code/test ratio chip and
// the "hide tests" toggle. Inline-styled so every host (branch-changed-files,
// git-changes, diff-viewer-modal) renders the same control without CSS wiring.

import { html, nothing, type TemplateResult } from 'lit';

import type { DiffKindSummary } from '@farmslot/protocol';

import { colors, fonts } from '../../styles/theme-tokens.js';
import { formatTestShare } from '../../utils/diff-test-filter.js';

export function renderDiffKindControls(args: {
  summary: DiffKindSummary;
  hideTests: boolean;
  onToggle: () => void;
}): TemplateResult | typeof nothing {
  const { summary, hideTests, onToggle } = args;
  const ratio = formatTestShare(summary);
  if (!ratio) return nothing;
  const detail =
    `code: ${summary.codeFiles} file${summary.codeFiles === 1 ? '' : 's'}, ${summary.codeLines} lines · ` +
    `tests: ${summary.testFiles} file${summary.testFiles === 1 ? '' : 's'}, ${summary.testLines} lines`;
  return html`
    <span
      class="diff-kind-ratio"
      data-testid="diff-kind-ratio"
      title=${detail}
      style="font-family:${fonts.mono}; font-size:10px; color:${colors.textMuted}; white-space:nowrap"
      >${ratio}</span
    >
    <button
      class="diff-kind-toggle"
      data-testid="diff-hide-tests"
      title=${hideTests
        ? 'Show test files in this list'
        : 'Hide test files so the list shows only app code (remembered across views)'}
      style="font-family:${fonts.mono}; font-size:10px; padding:1px 6px; border-radius:3px; border:1px solid ${hideTests
        ? colors.accent
        : colors.textMuted}; background:${hideTests
        ? `${colors.accent}22`
        : 'transparent'}; color:${hideTests ? colors.accent : colors.textMuted}; cursor:pointer"
      @click=${(event: Event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      ${hideTests ? `Show tests (${summary.testFiles})` : 'Hide tests'}
    </button>
  `;
}
