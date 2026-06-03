// methods/search.ts — search.query

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

import type { SearchMatch, SearchQueryParams, SearchQueryResult } from '@farmslot/protocol';

import { isLocal, loadSlotVars } from '../core/index.js';
import { loadPoolConfigs } from '../fleet/state.js';

const execFile = promisify(execFileCb);

async function resolveRepoPath(slotId: string): Promise<string> {
  const pools = await loadPoolConfigs();
  for (const pool of pools) {
    const slot = pool.slots.find((s) => s.id === slotId);
    if (slot) {
      if (!slot.repo) throw new Error(`No repo path configured for slot ${slotId}`);
      return slot.repo;
    }
  }
  throw new Error(`Slot ${slotId} not found in pool configs`);
}

async function assertLocalSlot(slotId: string): Promise<void> {
  const vars = await loadSlotVars(slotId);
  if (!isLocal(vars.host, vars.machine)) {
    throw new Error(`Slot ${slotId} is remote — workspace methods only support local slots`);
  }
}

export async function searchQuery(params: SearchQueryParams): Promise<SearchQueryResult> {
  await assertLocalSlot(params.slotId);
  const repoPath = await resolveRepoPath(params.slotId);

  const maxResults = Math.min(params.maxResults ?? 200, 1000);

  const args = ['grep', '-n', '--column', '-I'];
  if (!params.caseSensitive) args.push('-i');
  if (params.fileGlob) args.push(`--glob=${params.fileGlob}`);
  args.push('--', params.pattern);

  let stdout: string;
  try {
    const result = await execFile('git', args, {
      cwd: repoPath,
      maxBuffer: 5 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (err: unknown) {
    // git grep exits with code 1 when no matches found
    if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 1) {
      return { matches: [], truncated: false };
    }
    throw err;
  }

  const lines = stdout.split('\n').filter(Boolean);
  const truncated = lines.length > maxResults;
  const matches: SearchMatch[] = [];

  for (const line of lines.slice(0, maxResults)) {
    // Format: file:line:column:matched_text
    const firstColon = line.indexOf(':');
    if (firstColon === -1) continue;
    const secondColon = line.indexOf(':', firstColon + 1);
    if (secondColon === -1) continue;
    const thirdColon = line.indexOf(':', secondColon + 1);
    if (thirdColon === -1) continue;

    const file = line.substring(0, firstColon);
    const lineNum = parseInt(line.substring(firstColon + 1, secondColon), 10);
    const column = parseInt(line.substring(secondColon + 1, thirdColon), 10);
    const text = line.substring(thirdColon + 1);

    if (!isNaN(lineNum) && !isNaN(column)) {
      matches.push({ file, line: lineNum, column, text });
    }
  }

  return { matches, truncated };
}
