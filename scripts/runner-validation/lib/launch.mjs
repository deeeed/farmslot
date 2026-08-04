import { sendShellScript } from './tmux.mjs';

export function runLaunchInTmux(paneId, repo, runner, runnerAdapter, prompt, opts = {}) {
  const model = opts.model;
  const launch = runnerAdapter.buildLaunchCommand(repo, '.agent', prompt, model);
  sendShellScript(paneId, repo, [launch]);
}
