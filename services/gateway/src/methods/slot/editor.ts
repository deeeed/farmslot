import { execFile } from 'node:child_process';

import { isLocal, loadSlotVars } from '../../core/index.js';
import { loadPoolConfigs } from '../../fleet/state.js';

const EDITOR_APPS: Record<string, string> = {
  cursor: 'Cursor',
  vscode: 'Visual Studio Code',
};

export async function slotOpenEditor(params: {
  slotId: string;
  editor: string;
}): Promise<{ opened: boolean }> {
  const pools = await loadPoolConfigs();
  let repoPath = '';
  for (const pool of pools) {
    const slot = pool.slots.find((s) => s.id === params.slotId);
    if (slot) {
      repoPath = slot.repo;
      break;
    }
  }
  if (!repoPath) throw new Error(`No repo path for slot ${params.slotId}`);

  const vars = await loadSlotVars(params.slotId);
  const local = isLocal(vars.host, vars.machine);
  const appName = EDITOR_APPS[params.editor] || EDITOR_APPS['cursor'];

  if (local) {
    return new Promise((resolve, reject) => {
      execFile('open', ['-n', '-a', appName, '--args', repoPath], (err) => {
        if (err) reject(new Error(`Failed to open ${appName}: ${err.message}`));
        else resolve({ opened: true });
      });
    });
  }

  // Remote slot: open via SSH remote (Cursor/VS Code support --remote ssh-remote+host)
  const cliCmd = params.editor === 'vscode' ? 'code' : 'cursor';
  const sshHost = vars.sshTarget; // e.g. mini.local
  return new Promise((resolve, reject) => {
    execFile(cliCmd, ['--remote', `ssh-remote+${sshHost}`, repoPath], (err) => {
      if (err) reject(new Error(`Failed to open ${cliCmd} remote: ${err.message}`));
      else resolve({ opened: true });
    });
  });
}

// ─── killAgentInSession — port of lib/slot-common.sh kill_agent_in_session ───
