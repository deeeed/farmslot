import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// No Farmslot test may start, attach to or kill a real tmux server. Run from
// inside a tmux pane, a test's tmux calls reach the operator's own server
// ($TMUX wins over TMUX_TMPDIR), and a `kill-server` there ends every session
// on the machine. Tests check tmux behaviour through the commands the code
// issues to a mocked exec layer instead.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Tests that predate the rule and still run real tmux sessions (each scoped to
// its own pid-named session). The list only shrinks: convert a file to the
// mocked exec layer, then delete its entry.
const KNOWN_REAL_TMUX_TESTS = new Set([
  '.agents/skills/tmux-model-driver/tests/send-and-verify.test.sh',
  '.agents/skills/tmux-model-driver/tests/send-shell-script.test.sh',
  'packages/agent-runtime/src/native/review-terminal.test.ts',
  'packages/cli/src/onboarding/uninstall.test.ts',
  'services/gateway/src/agents/runtime-recovery.test.ts',
  'services/gateway/src/backlog/refinement.test.ts',
  'services/gateway/src/methods/slot.test.ts',
  'services/gateway/src/run-engine/core-prepare.test.ts',
  'services/gateway/src/run-engine/stack-base-prepare.test.ts',
  'services/gateway/src/run-engine/start-ref-on-current-branch.test.ts',
  'services/gateway/src/runners/session-process.test.ts',
  'services/node/src/commands/tmux.test.ts',
]);

const TEST_FILE = /\.test\.(?:[cm]?[jt]sx?|sh)$/u;

/** Why a test file reaches a real tmux server, or null. */
export function realTmuxUse(rel, source) {
  // The tmux binary as the command of a spawn/exec call: spawn('tmux', …),
  // execFileSync('tmux', …), execSync('tmux new-session …'), and so on.
  const spawned =
    /\b(?:spawn|spawnSync|execFile|execFileSync|execFileAsync|exec|execSync|execa)\(\s*['"`]tmux\b/u.exec(
      source,
    );
  if (spawned) return `spawns tmux: ${spawned[0]}`;
  // kill-server as an argument, wherever the call is assembled.
  const killServer = /['"`]kill-server['"`]/u.exec(source);
  if (killServer) return `passes kill-server: ${killServer[0]}`;
  if (rel.endsWith('.sh')) {
    const shell = /^\s*(?:command\s+|exec\s+)?tmux\s/mu.exec(source);
    if (shell) return `runs tmux: ${shell[0].trim()}`;
  }
  return null;
}

function trackedTestFiles() {
  return execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter((rel) => TEST_FILE.test(rel));
}

test('no test file reaches a real tmux server outside the shrinking known list', () => {
  const offenders = [];
  const stale = [];
  for (const rel of trackedTestFiles()) {
    if (rel === 'scripts/quality/no-real-tmux-in-tests.test.mjs') continue;
    const use = realTmuxUse(rel, readFileSync(path.join(repoRoot, rel), 'utf8'));
    if (use && !KNOWN_REAL_TMUX_TESTS.has(rel)) offenders.push(`${rel}: ${use}`);
    if (!use && KNOWN_REAL_TMUX_TESTS.has(rel)) stale.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    'Tests must not start, attach to or kill a real tmux server. Mock the exec layer and assert the tmux commands instead.',
  );
  assert.deepEqual(
    stale,
    [],
    'These files no longer run tmux: remove them from KNOWN_REAL_TMUX_TESTS.',
  );
});

test('the detector catches direct tmux calls and kill-server, and ignores mocked command strings', () => {
  assert.match(realTmuxUse('a.test.ts', `spawnSync('tmux', ['ls'])`), /spawns tmux/u);
  assert.match(realTmuxUse('a.test.ts', 'execSync(`tmux new-session -d -s x`)'), /spawns tmux/u);
  assert.match(realTmuxUse('a.test.ts', `await execFileAsync("tmux", args)`), /spawns tmux/u);
  assert.match(realTmuxUse('a.test.ts', `run(bin, ['-S', sock, 'kill-server'])`), /kill-server/u);
  assert.match(realTmuxUse('a.test.sh', 'tmux kill-session -t x\n'), /runs tmux/u);
  assert.equal(
    realTmuxUse(
      'a.test.ts',
      `assert.ok(issued.includes("new-session -d -s 'mm-1' -n 'dev' -c '/tmp/repo' 2>&1"))`,
    ),
    null,
  );
  assert.equal(realTmuxUse('a.test.ts', `// never kill-server; scoped kill-session only`), null);
});
