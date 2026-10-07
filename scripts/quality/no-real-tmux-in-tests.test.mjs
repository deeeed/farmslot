import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { tmuxSandboxEnvironment } from './run-tsx-tests.mjs';

// No Farmslot test may start, attach to or kill the operator's tmux server. Run
// from inside a tmux pane, a test's tmux calls reach the operator's own server
// ($TMUX wins over TMUX_TMPDIR), and a `kill-server` there ends every session
// on the machine.
//
// Tests that need real tmux run it on a private server only:
// - TypeScript tests run under scripts/quality/run-tsx-tests.mjs, which drops
//   TMUX/TMUX_PANE and points TMUX_TMPDIR at a directory it owns. They skip
//   unless FARMSLOT_TMUX_SANDBOX is set, and pass it with -S on their own calls.
// - Shell tests set up the same sandbox themselves and end it by its socket.
// Everything else mocks the exec layer and asserts the tmux commands.
//
// This guard stops accidents; it is not a proof. A tmux binary held in a
// variable, or tmux inside a command string handed to a shell, gets past it,
// and the runner sandbox is what keeps those off the operator's server.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Test files, and shell test scripts named test-*.sh (test-onboarding.sh).
// scripts/runner-validation/ is live validation against real slots, not a test.
const TEST_FILE = /\.test\.(?:[cm]?[jt]sx?|sh)$|(?:^|\/)test-[^/]*\.sh$/u;

const ENV_PREFIX = String.raw`env\s+(?:-u\s+\w+\s+|-\S+\s+|\w+=\S*\s+)*`;
const SPAWN_TMUX = new RegExp(
  String.raw`\b(?:spawn|spawnSync|execFile|execFileSync|execFileAsync|exec|execSync|execa)\(\s*['"\x60](?:${ENV_PREFIX})?(?:[^'"\x60\s]*\/)?tmux\b`,
  'gu',
);
const SHELL_TMUX = new RegExp(
  String.raw`(?:^\s*|\$\(|&&\s*|\|\|\s*|;\s*|\|\s*)(?:command\s+|exec\s+|${ENV_PREFIX})?(?:[^\s'"]*\/)?tmux\s+(?!-S "\$FARMSLOT_TMUX_SANDBOX"\s)`,
  'mu',
);

const lineOf = (source, index) => source.slice(0, index).split('\n').length;

/** Every way a test file breaks the rule; empty when it has none. */
export function tmuxRuleViolations(rel, source) {
  const violations = [];
  if (rel.endsWith('.sh')) {
    const code = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    if (!/(?:^|[^-\w])tmux\b/mu.test(code)) return violations;
    const unsandboxed = SHELL_TMUX.exec(code);
    if (unsandboxed)
      violations.push(`runs tmux without -S "$FARMSLOT_TMUX_SANDBOX": ${unsandboxed[0].trim()}`);
    if (!/^\s*unset TMUX TMUX_PANE\b/mu.test(code) || !/FARMSLOT_TMUX_SANDBOX=/u.test(code)) {
      violations.push(
        'runs tmux without the private-server setup (unset TMUX, FARMSLOT_TMUX_SANDBOX)',
      );
    }
    for (const line of code.split('\n')) {
      if (
        /kill-server/u.test(line) &&
        !/tmux -S "\$FARMSLOT_TMUX_SANDBOX" kill-server/u.test(line)
      ) {
        violations.push(`kill-server outside the sandbox socket: ${line.trim()}`);
      }
    }
    return violations;
  }
  const spawns = [...source.matchAll(SPAWN_TMUX)];
  for (const spawn of spawns) {
    const after = source.slice(spawn.index, spawn.index + spawn[0].length + 60);
    if (!/['"`]tmux['"`],\s*\[\s*'-S',\s*tmuxSandbox!?,/u.test(after)) {
      violations.push(
        `line ${lineOf(source, spawn.index)}: spawns tmux without -S tmuxSandbox: ${spawn[0]}`,
      );
    }
  }
  if (spawns.length > 0 && !source.includes('process.env.FARMSLOT_TMUX_SANDBOX')) {
    violations.push('runs tmux without requiring the test runner sandbox (FARMSLOT_TMUX_SANDBOX)');
  }
  const killServer = /['"`]kill-server['"`]/u.exec(source);
  if (killServer) {
    violations.push(
      `line ${lineOf(source, killServer.index)}: passes kill-server (the runner ends its own server)`,
    );
  }
  return violations;
}

function trackedTestFiles() {
  return execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter(
      (rel) => TEST_FILE.test(rel) && rel !== 'scripts/quality/no-real-tmux-in-tests.test.mjs',
    );
}

test('no test file can reach a tmux server other than its private sandbox', () => {
  const offenders = trackedTestFiles().flatMap((rel) =>
    tmuxRuleViolations(rel, readFileSync(path.join(repoRoot, rel), 'utf8')).map(
      (violation) => `${rel}: ${violation}`,
    ),
  );
  assert.deepEqual(
    offenders,
    [],
    'Run real tmux only on the private sandbox server (see the header of this file), or mock the exec layer.',
  );
});

test('the runner gives every test process a private tmux server and no $TMUX', () => {
  const env = tmuxSandboxEnvironment(
    { TMUX: '/private/tmp/tmux-501/default,1,0', TMUX_PANE: '%1', KEEP: 'yes' },
    '/tmp/fs-tmux-x',
    501,
  );
  assert.equal(env.TMUX, undefined);
  assert.equal(env.TMUX_PANE, undefined);
  assert.equal(env.TMUX_TMPDIR, '/tmp/fs-tmux-x');
  // The socket plain `tmux` uses under that TMUX_TMPDIR, so code under test and
  // the test's own -S calls share one private server.
  assert.equal(env.FARMSLOT_TMUX_SANDBOX, '/tmp/fs-tmux-x/tmux-501/default');
  assert.equal(env.KEEP, 'yes');
});

test('the detector holds TypeScript and shell tests to the sandbox rule', () => {
  const sandboxed =
    'const tmuxSandbox = process.env.FARMSLOT_TMUX_SANDBOX ? process.env.FARMSLOT_TMUX_SANDBOX : null;\n';
  // TypeScript: -S on the sandbox, and the sandbox required.
  assert.deepEqual(
    tmuxRuleViolations('a.test.ts', `${sandboxed}spawnSync('tmux', ['-S', tmuxSandbox!, 'ls'])`),
    [],
  );
  assert.match(
    tmuxRuleViolations('a.test.ts', `${sandboxed}spawnSync('tmux', ['ls'])`)[0],
    /without -S/u,
  );
  assert.match(
    tmuxRuleViolations('a.test.ts', `${sandboxed}spawnSync('/opt/homebrew/bin/tmux', ['ls'])`)[0],
    /without -S/u,
  );
  assert.match(
    tmuxRuleViolations('a.test.ts', 'execSync(`env -u TMUX tmux ls`)')[0],
    /without -S/u,
  );
  assert.match(
    tmuxRuleViolations('a.test.ts', `spawnSync('tmux', ['-S', tmuxSandbox!, 'ls'])`)[0],
    /requiring the test runner sandbox/u,
  );
  assert.match(
    tmuxRuleViolations('a.test.ts', `${sandboxed}run(bin, ['-S', sock, 'kill-server'])`)[0],
    /kill-server/u,
  );
  // Mocked command strings and comments are not tmux calls.
  assert.deepEqual(
    tmuxRuleViolations(
      'a.test.ts',
      `assert.ok(issued.includes("new-session -d -s 'mm-1' 2>&1")); // never kill-server`,
    ),
    [],
  );
  // Shell: setup, -S on every call, kill-server only by the sandbox socket.
  const setup = 'unset TMUX TMUX_PANE\nFARMSLOT_TMUX_SANDBOX="$TMUX_TMPDIR/tmux-1/default"\n';
  assert.deepEqual(
    tmuxRuleViolations(
      'test-x.sh',
      `${setup}tmux -S "$FARMSLOT_TMUX_SANDBOX" new-session -d -s x\ntmux -S "$FARMSLOT_TMUX_SANDBOX" kill-server\n`,
    ),
    [],
  );
  assert.match(
    tmuxRuleViolations('a.test.sh', `${setup}tmux kill-session -t x\n`)[0],
    /without -S/u,
  );
  assert.match(
    tmuxRuleViolations('a.test.sh', `${setup}id=$(tmux display-message -p x)\n`)[0],
    /without -S/u,
  );
  assert.match(tmuxRuleViolations('a.test.sh', `${setup}  /usr/bin/tmux ls\n`)[0], /without -S/u);
  assert.match(
    tmuxRuleViolations('a.test.sh', `${setup}tmux -S "$OTHER_SOCKET" new-session -d -s x\n`)[0],
    /without -S/u,
  );
  assert.match(
    tmuxRuleViolations('a.test.sh', 'tmux -S "$FARMSLOT_TMUX_SANDBOX" ls\n')[0],
    /private-server setup/u,
  );
  assert.match(
    tmuxRuleViolations('a.test.sh', `${setup}tmux -S "$SOCK" kill-server\n`).at(-1),
    /kill-server outside the sandbox socket/u,
  );
  assert.deepEqual(
    tmuxRuleViolations('a.test.sh', '# tmux kill-server is never used here\necho ok\n'),
    [],
  );
});
