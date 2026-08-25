import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { SlotVars } from '../core/config.js';

const vars = { slotId: 'macwork-mm-2', remoteRepo: '/tmp/repo' } as SlotVars;
const issuedCommands: string[] = [];

function cmdIncludes(cmd: string, fragment: string): boolean {
  return cmd.includes(fragment);
}

mock.module('../core/exec.js', {
  namedExports: {
    isLocal: () => true,
    execLocal: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    execArgvOnSlot: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    execFileArgv: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    execOnSlot: async (_vars: SlotVars, cmd: string) => {
      issuedCommands.push(cmd);
      if (cmdIncludes(cmd, 'has-session')) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (cmdIncludes(cmd, "list-panes -a -F '#{session_name}")) {
        const windows: string[] = [];
        if (issuedCommands.some((command) => cmdIncludes(command, "-n 'dev'"))) {
          windows.push('mm-2\tdev\t@201\t2\t100\t%201\t2201');
        }
        if (issuedCommands.some((command) => cmdIncludes(command, "-n 'self-review'"))) {
          windows.push('mm-2\tself-review\t@202\t3\t101\t%202\t2202');
        }
        return { exitCode: 0, stdout: windows.join('\n'), stderr: '' };
      }
      if (cmdIncludes(cmd, 'list-panes') && cmdIncludes(cmd, 'mm-2:1.1')) {
        return { exitCode: 0, stdout: '0', stderr: '' };
      }
      if (cmdIncludes(cmd, 'display-message') && cmdIncludes(cmd, 'mm-2:1.1')) {
        return { exitCode: 0, stdout: 'metro-8062', stderr: '' };
      }
      if (cmdIncludes(cmd, 'new-window') && cmdIncludes(cmd, 'dev')) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (cmdIncludes(cmd, 'list-panes') && cmdIncludes(cmd, 'mm-2:dev')) {
        return { exitCode: 0, stdout: '0', stderr: '' };
      }
      if (cmdIncludes(cmd, 'list-windows') && cmdIncludes(cmd, "list-windows -t 'mm-2'")) {
        return { exitCode: 0, stdout: '1', stderr: '' };
      }
      if (cmdIncludes(cmd, 'list-panes') && cmdIncludes(cmd, 'mm-2:self-review')) {
        return { exitCode: 1, stdout: '', stderr: 'not found' };
      }
      if (cmdIncludes(cmd, 'new-window') && cmdIncludes(cmd, 'self-review')) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      // Pane rediscovery fixtures: stored target dead, live accepting runner elsewhere.
      if (cmdIncludes(cmd, "list-panes -s -t 'coredev-1'")) {
        return {
          exitCode: 0,
          stdout: '1|dev|0|zsh\n2|rev-claude|0|claude\n3|zsh|0|claude',
          stderr: '',
        };
      }
      if (cmdIncludes(cmd, 'display-message') && cmdIncludes(cmd, "'coredev-1:dev'")) {
        return { exitCode: 0, stdout: 'zsh', stderr: '' };
      }
      if (cmdIncludes(cmd, 'display-message') && cmdIncludes(cmd, "'coredev-1:rev-claude.0'")) {
        return { exitCode: 0, stdout: 'claude', stderr: '' };
      }
      if (cmdIncludes(cmd, 'display-message') && cmdIncludes(cmd, "'coredev-1:zsh.0'")) {
        return { exitCode: 0, stdout: 'claude', stderr: '' };
      }
      if (cmdIncludes(cmd, 'capture-pane') && cmdIncludes(cmd, "'coredev-1:zsh.0'")) {
        return { exitCode: 0, stdout: 'Welcome back!\n❯\n', stderr: '' };
      }
      // Stored target still hosts the runner: keep it without adopting another pane.
      if (cmdIncludes(cmd, "list-panes -s -t 'coredev-2'")) {
        return { exitCode: 0, stdout: '1|dev|0|claude', stderr: '' };
      }
      if (cmdIncludes(cmd, 'display-message') && cmdIncludes(cmd, "'coredev-2:dev'")) {
        return { exitCode: 0, stdout: 'claude', stderr: '' };
      }
      // No runner pane anywhere in the session.
      if (cmdIncludes(cmd, "list-panes -s -t 'coredev-3'")) {
        return { exitCode: 0, stdout: '1|dev|0|zsh\n2|zsh|0|zsh', stderr: '' };
      }
      if (cmdIncludes(cmd, 'display-message') && cmdIncludes(cmd, 'coredev-3')) {
        return { exitCode: 0, stdout: 'zsh', stderr: '' };
      }
      // Runner pane exists elsewhere but is mid-turn, not at an accepting prompt.
      if (cmdIncludes(cmd, "list-panes -s -t 'coredev-4'")) {
        return { exitCode: 0, stdout: '1|dev|0|zsh\n2|zsh|0|claude', stderr: '' };
      }
      if (cmdIncludes(cmd, 'display-message') && cmdIncludes(cmd, "'coredev-4:dev'")) {
        return { exitCode: 0, stdout: 'zsh', stderr: '' };
      }
      if (cmdIncludes(cmd, 'display-message') && cmdIncludes(cmd, "'coredev-4:zsh.0'")) {
        return { exitCode: 0, stdout: 'claude', stderr: '' };
      }
      if (cmdIncludes(cmd, 'capture-pane') && cmdIncludes(cmd, "'coredev-4:zsh.0'")) {
        return { exitCode: 0, stdout: '✻ Working… (esc to interrupt)\n', stderr: '' };
      }
      // Claude's wrapped binary reports a semver pane command; the actual runner
      // is a grandchild of the tmux shell and must be found through the shared
      // descendant-tree probe rather than direct-child `pgrep -P`.
      if (cmdIncludes(cmd, "list-panes -s -t 'coredev-5'")) {
        return { exitCode: 0, stdout: '1|dev|0|zsh|4141\n2|fix|0|2.1.220|4242', stderr: '' };
      }
      if (cmdIncludes(cmd, 'display-message') && cmdIncludes(cmd, "'coredev-5:dev'")) {
        return { exitCode: 0, stdout: 'zsh', stderr: '' };
      }
      if (cmdIncludes(cmd, 'display-message') && cmdIncludes(cmd, "'coredev-5:fix.0'")) {
        return { exitCode: 0, stdout: '2.1.220', stderr: '' };
      }
      if (cmdIncludes(cmd, 'list-panes') && cmdIncludes(cmd, "'coredev-5:fix.0'")) {
        return { exitCode: 0, stdout: '4242', stderr: '' };
      }
      if (cmdIncludes(cmd, "root='4242'")) {
        return { exitCode: 0, stdout: '4343\n', stderr: '' };
      }
      if (cmdIncludes(cmd, 'capture-pane') && cmdIncludes(cmd, "'coredev-5:fix.0'")) {
        return { exitCode: 0, stdout: 'Welcome back!\n❯\n', stderr: '' };
      }
      return { exitCode: 1, stdout: '', stderr: 'unexpected command' };
    },
  },
});

const { ensureTmuxTargetReadyForRelaunch, rediscoverAcceptingWorkerPane } =
  await import('./worker-lifecycle.js');

test('ensureTmuxTargetReadyForRelaunch recreates role window when numeric index drifted', async () => {
  const target = await ensureTmuxTargetReadyForRelaunch(vars, 'mm-2', 'mm-2:1.1', 'dev');
  assert.equal(target, 'mm-2:dev');
});

test('ensureTmuxTargetReadyForRelaunch derives role window from flow when context window is missing', async () => {
  const target = await ensureTmuxTargetReadyForRelaunch(vars, 'mm-2', 'mm-2:1.1', null, 'dev');
  assert.equal(target, 'mm-2:dev');
});

test('ensureTmuxTargetReadyForRelaunch never promotes a bare session active reviewer', async () => {
  const createsBefore = issuedCommands.filter((command) =>
    command.includes("new-window -t '=mm-2' -n 'dev'"),
  ).length;
  const target = await ensureTmuxTargetReadyForRelaunch(vars, 'mm-2', 'mm-2', null, 'dev');
  assert.equal(target, 'mm-2:dev');
  assert.equal(
    issuedCommands.filter((command) => command.includes("new-window -t '=mm-2' -n 'dev'")).length,
    createsBefore,
  );
});

test('ensureTmuxTargetReadyForRelaunch keeps named role window when pane is alive', async () => {
  const target = await ensureTmuxTargetReadyForRelaunch(vars, 'mm-2', 'mm-2:dev', 'dev');
  assert.equal(target, 'mm-2:dev');
});

test('ensureTmuxTargetReadyForRelaunch creates missing named window', async () => {
  const target = await ensureTmuxTargetReadyForRelaunch(
    vars,
    'mm-2',
    'mm-2:self-review',
    'self-review',
  );
  assert.equal(target, 'mm-2:self-review');
});

test('ensureTmuxTargetReadyForRelaunch resolves first window for base-index-1 hosts', async () => {
  const target = await ensureTmuxTargetReadyForRelaunch(vars, 'mm-2', 'mm-2:0', null);
  assert.equal(target, 'mm-2:1');
});

test('rediscoverAcceptingWorkerPane adopts the accepting runner pane when the stored target is a bare shell', async () => {
  const result = await rediscoverAcceptingWorkerPane(vars, 'coredev-1', 'claude', 'coredev-1:dev');
  assert.equal(result.target, 'coredev-1:zsh.0');
  assert.equal(result.window, 'zsh');
  assert.deepEqual(result.seenWindows, [
    '1:dev pane 0 (zsh)',
    '2:rev-claude pane 0 (claude)',
    '3:zsh pane 0 (claude)',
  ]);
});

test('rediscoverAcceptingWorkerPane keeps the stored target while it still hosts the runner', async () => {
  const result = await rediscoverAcceptingWorkerPane(vars, 'coredev-2', 'claude', 'coredev-2:dev');
  assert.equal(result.target, 'coredev-2:dev');
  assert.equal(result.window, 'dev');
});

test('rediscoverAcceptingWorkerPane returns null with the pane inventory when nothing hosts the runner', async () => {
  const result = await rediscoverAcceptingWorkerPane(vars, 'coredev-3', 'claude', 'coredev-3:dev');
  assert.equal(result.target, null);
  assert.equal(result.window, null);
  assert.deepEqual(result.seenWindows, ['1:dev pane 0 (zsh)', '2:zsh pane 0 (zsh)']);
});

test('rediscoverAcceptingWorkerPane does not adopt a runner pane that is mid-turn', async () => {
  const result = await rediscoverAcceptingWorkerPane(vars, 'coredev-4', 'claude', 'coredev-4:dev');
  assert.equal(result.target, null);
});

test('rediscoverAcceptingWorkerPane adopts a wrapped runner found below the pane shell', async () => {
  const commandOffset = issuedCommands.length;
  const result = await rediscoverAcceptingWorkerPane(vars, 'coredev-5', 'claude', 'coredev-5:dev');
  assert.equal(result.target, 'coredev-5:fix.0');
  assert.equal(result.window, 'fix');
  assert.ok(
    issuedCommands.slice(commandOffset).some((command) => command.includes("root='4242'")),
    'the regression must exercise the descendant-tree probe, not a fused direct-child mock',
  );
});
