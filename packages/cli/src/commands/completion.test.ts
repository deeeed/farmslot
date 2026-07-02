import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  detectShell,
  installBashCompletion,
  installFishCompletion,
  installZshCompletion,
  shellQuoteForZsh,
} from './completion.js';

test('shellQuoteForZsh preserves apostrophes in paths', () => {
  const quoted = shellQuoteForZsh("/Users/O'Connor/.local/share/zsh/site-functions");
  assert.equal(quoted, "'/Users/O'\\''Connor/.local/share/zsh/site-functions'");
});

test('detectShell resolves zsh/bash/fish from $SHELL by basename', () => {
  assert.equal(detectShell({ SHELL: '/bin/zsh' }), 'zsh');
  assert.equal(detectShell({ SHELL: '/usr/bin/bash' }), 'bash');
  assert.equal(detectShell({ SHELL: '/usr/local/bin/fish' }), 'fish');
});

test('detectShell falls back to zsh when $SHELL is unset or unrecognized', () => {
  assert.equal(detectShell({}), 'zsh');
  assert.equal(detectShell({ SHELL: '/bin/tcsh' }), 'zsh');
});

// The installers write into $HOME (rc files) and honor per-shell XDG-style env
// overrides for the completion dir itself — point both at a disposable temp
// tree so a test run never touches the real developer environment.
function withTempHome(run: (home: string) => void): void {
  const home = mkdtempSync(path.join(tmpdir(), 'fs-completion-home-'));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    run(home);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}

test('installZshCompletion writes the completion + one fpath block, idempotently', () => {
  withTempHome((home) => {
    const first = installZshCompletion();
    const second = installZshCompletion();
    assert.equal(first, second);
    assert.ok(readFileSync(first, 'utf8').includes('#compdef farmslot'));

    const zshrc = readFileSync(path.join(home, '.zshrc'), 'utf8');
    const occurrences = zshrc.split('fpath=(').length - 1;
    assert.equal(occurrences, 1, 're-running must not duplicate the fpath block');
  });
});

test('installBashCompletion writes the completion + one source line, idempotently', () => {
  withTempHome((home) => {
    const first = installBashCompletion();
    const second = installBashCompletion();
    assert.equal(first, second);
    assert.ok(readFileSync(first, 'utf8').includes('_farmslot_completions'));

    // The source line references the completion path twice (`[ -f … ] && . …`),
    // so count the block marker rather than the path itself.
    const bashrc = readFileSync(path.join(home, '.bashrc'), 'utf8');
    const occurrences = bashrc.split('# Farmslot CLI completions').length - 1;
    assert.equal(occurrences, 1, 're-running must not duplicate the source line');
  });
});

test('installFishCompletion writes the completion file with no rc edit needed', () => {
  withTempHome(() => {
    const first = installFishCompletion();
    const second = installFishCompletion();
    assert.equal(first, second);
    assert.ok(first.endsWith('farmslot.fish'));
    assert.ok(readFileSync(first, 'utf8').includes('complete -c farmslot'));
  });
});
