import { sendShellScript } from './tmux.mjs';

export function runLaunchInTmux(paneId, repo, runner, runnerAdapter, prompt) {
  const launch =
    runner === 'codex'
      ? runnerAdapter.buildLaunchCommand(repo, '.agent', prompt)
      : runnerAdapter.buildLaunchCommand(prompt);
  sendShellScript(paneId, repo, [launch]);
}