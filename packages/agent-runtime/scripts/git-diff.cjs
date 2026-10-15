'use strict';

// Runtime diff views and fingerprints share one formatting policy. Range,
// pathspec, binary and summary flags remain with the owning caller.
const GIT_DIFF_ARGS = Object.freeze([
  '-c',
  'core.quotePath=false',
  '-c',
  'diff.mnemonicPrefix=false',
  '-c',
  'diff.noprefix=false',
  '-c',
  'diff.suppressBlankEmpty=false',
  '-c',
  'diff.orderFile=/dev/null',
  '-c',
  'diff.context=3',
  'diff',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--no-relative',
  '--inter-hunk-context=0',
  '--diff-algorithm=myers',
  '--indent-heuristic',
  '--find-renames=50%',
  '-l1000',
  '--submodule=short',
  '--ignore-submodules=none',
  '--output-indicator-new=+',
  '--output-indicator-old=-',
  '--output-indicator-context= ',
]);

const GIT_DIFF_COMMAND = `git ${GIT_DIFF_ARGS.map((arg) => (arg.includes(' ') ? `'${arg}'` : arg)).join(' ')}`;

function gitDiffArgs(args = []) {
  return [...GIT_DIFF_ARGS, ...args];
}

module.exports = { GIT_DIFF_ARGS, GIT_DIFF_COMMAND, gitDiffArgs };
