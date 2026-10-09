// The one "hide tests" wiring for every diff and changed-file list. A host adds
// this controller and renders its rows from `split()`; the controller owns the
// remembered preference, the matcher built from the project's test globs, the
// header controls and the hand-off when the selected file gets hidden. A
// one-file diff outside such a list goes through `renderFileDiff()`.
// diff-test-filter-coverage.test.ts fails for a diff view that skips it.

import {
  html,
  nothing,
  type ReactiveController,
  type ReactiveControllerHost,
  type TemplateResult,
} from 'lit';

import {
  classifyDiffFile,
  compileTestFileMatcher,
  DEFAULT_TEST_FILE_MATCHER,
  type DiffFileKind,
  type DiffKindSummary,
  summarizeDiffKinds,
  type TestFileMatcher,
} from '@farmslot/protocol';

import { colors, fonts } from '../../styles/theme-tokens.js';
import {
  type DiffKindSplit,
  readHideTestsPref,
  splitDiffFilesByKind,
  subscribeHideTestsPref,
  writeHideTestsPref,
} from '../../utils/diff-test-filter.js';

import { renderDiffKindControls } from './diff-kind-controls.js';

export interface DiffTestFilterOptions {
  /**
   * Effective test globs for this diff (`git.branchDiff` testFilePatterns, i.e.
   * the run's project `diff_view` config); null or absent uses the defaults.
   */
  patterns?: () => readonly string[] | null | undefined;
  /** Runs after the preference flips, e.g. to move a selection off a hidden file. */
  onChange?: () => void;
}

export class DiffTestFilterController implements ReactiveController {
  hideTests = readHideTestsPref();
  private _unsubscribe: (() => void) | null = null;
  private _matcherCache: { patterns: readonly string[]; matcher: TestFileMatcher } | null = null;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly options: DiffTestFilterOptions = {},
  ) {
    host.addController(this);
  }

  hostConnected(): void {
    // A flip while disconnected reaches the host like a live one.
    const hide = readHideTestsPref();
    if (hide !== this.hideTests) {
      this.hideTests = hide;
      this.host.requestUpdate();
      this.options.onChange?.();
    }
    this._unsubscribe = subscribeHideTestsPref((hide) => {
      this.hideTests = hide;
      this.host.requestUpdate();
      this.options.onChange?.();
    });
  }

  hostDisconnected(): void {
    this._unsubscribe?.();
    this._unsubscribe = null;
  }

  get matcher(): TestFileMatcher {
    const patterns = this.options.patterns?.();
    if (!patterns) return DEFAULT_TEST_FILE_MATCHER;
    if (this._matcherCache?.patterns !== patterns) {
      this._matcherCache = { patterns, matcher: compileTestFileMatcher(patterns) };
    }
    return this._matcherCache.matcher;
  }

  toggle(): void {
    writeHideTestsPref(!this.hideTests);
  }

  /** `keepPath` stays listed while hidden, for lists whose selection lives in the host. */
  split<T extends { path: string; additions: number; deletions: number; kind?: DiffFileKind }>(
    files: readonly T[],
    keepPath?: string,
  ): DiffKindSplit<T> {
    return splitDiffFilesByKind(files, this.hideTests, { keepPath, matcher: this.matcher });
  }

  /** For rows without a stamped kind or line counts (working-tree status entries). */
  hides(path: string): boolean {
    return this.hideTests && classifyDiffFile(path, this.matcher) === 'test';
  }

  renderControls(summary: DiffKindSummary): TemplateResult | typeof nothing {
    return renderDiffKindControls({
      summary,
      hideTests: this.hideTests,
      onToggle: () => this.toggle(),
    });
  }

  /**
   * One file's diff outside a filtered list (an editor tab, a Files-mode
   * preview): the toggle when the file is a test, and a placeholder in place of
   * the diff while tests are hidden. Inline styles, like the controls: hosts
   * with a shadow root (native-workspace, slot-workspace) can't see page CSS.
   */
  renderFileDiff(path: string, diff: () => unknown): TemplateResult {
    const controls = this.renderControls(
      summarizeDiffKinds([{ path, additions: 0, deletions: 0 }], this.matcher),
    );
    return html`${controls === nothing
      ? nothing
      : html`<div
          class="diff-test-file-bar"
          style="display:flex; justify-content:flex-end; padding:2px 8px; flex-shrink:0"
        >
          ${controls}
        </div>`}${this.hides(path)
      ? html`<div
          class="diff-test-file-hidden"
          data-testid="diff-test-file-hidden"
          style="flex:1; display:flex; align-items:center; justify-content:center; padding:16px; font-family:${fonts.mono}; font-size:12px; color:${colors.textMuted}"
        >
          Test file hidden — show tests to see its diff
        </div>`
      : diff()}`;
  }
}
