// The one "hide tests" wiring for every diff and changed-file list. A host adds
// this controller and renders its rows from `split()`; the controller owns the
// remembered preference, the matcher built from the project's test globs, the
// header controls and the hand-off when the selected file gets hidden.
// diff-test-filter-coverage.test.ts fails for a diff view that skips it.

import type { nothing, ReactiveController, ReactiveControllerHost, TemplateResult } from 'lit';

import {
  classifyDiffFile,
  compileTestFileMatcher,
  DEFAULT_TEST_FILE_MATCHER,
  type DiffFileKind,
  type DiffKindSummary,
  type TestFileMatcher,
} from '@farmslot/protocol';

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
    this.hideTests = readHideTestsPref();
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
}
