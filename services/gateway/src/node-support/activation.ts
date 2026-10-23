import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Run } from '@farmslot/protocol';
import { isRecord } from '@farmslot/protocol/recipe';

import { loadMachineSlots, loadProjectVars, loadSlotVars, type SlotVars } from '../core/config.js';
import { shellQuote } from '../core/tmux.js';
import { nodeSupportHashPath } from '../runners/runner-observability.js';
import { listRuns, runsDirectory } from '../runs/store.js';

export interface NodeSupportRetentionReferences {
  selectionPaths: string[];
  runHashes: string[];
}

/** Historical outputs can refer to an older bundle than the slot now selects. */
function supportHashes(values: readonly unknown[]): string[] {
  const hashes = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      if (/^[a-f0-9]{64}$/.test(value)) hashes.add(value);
      for (const match of value.matchAll(
        /\/farmslot-node\/support\/([a-f0-9]{64})(?=$|[\s/"'\\])/g,
      ))
        hashes.add(match[1]);
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  values.forEach(visit);
  return [...hashes];
}

export function referencedNodeSupportHashes(runs: readonly Run[]): string[] {
  return supportHashes(runs.filter((run) => !run.archivedAt));
}

/** One-shot activators do not have the gateway's run store loaded in memory. */
export async function persistedNodeSupportHashes(directory: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  const hashes = new Set<string>();
  for (const name of names.filter((name) => name.endsWith('.json'))) {
    const record: unknown = JSON.parse(await readFile(path.join(directory, name), 'utf8'));
    if (!isRecord(record)) throw new Error(`Unreadable node-support run references: ${name}`);
    if (!record.archivedAt) for (const hash of supportHashes([record])) hashes.add(hash);
  }
  return [...hashes];
}

export async function nodeSupportRetentionReferences(
  vars: SlotVars,
): Promise<NodeSupportRetentionReferences> {
  const selectionPaths = [];
  for (const slot of await loadMachineSlots(vars.machine)) {
    // Disabled slots retain their selection too. An unreadable config refuses
    // pruning instead of guessing that the slot holds no bundle.
    const selected = await loadSlotVars(slot.id);
    const project = await loadProjectVars(selected.projectName);
    selectionPaths.push(nodeSupportHashPath(selected.remoteRepo, project.runtimeDir));
  }
  return {
    selectionPaths,
    runHashes: [
      ...new Set([
        ...referencedNodeSupportHashes(listRuns().runs),
        ...(await persistedNodeSupportHashes(runsDirectory())),
      ]),
    ],
  };
}

export interface NodeSupportActivationParams {
  supportDir: string;
  supportHash: string;
  selectionPath: string;
  references: NodeSupportRetentionReferences;
  publishCommand?: string;
  verifyCommand: string;
}

/** Publish, verify, select and prune under one node-owned lock, including other gateways. */
export function buildNodeSupportActivationCommand(params: NodeSupportActivationParams): string {
  const payload = { ...params, supportRoot: path.posix.dirname(params.supportDir) };
  const script = `import fcntl,json,os,re,shutil,subprocess,sys,time
from pathlib import Path
d=json.loads(sys.argv[1]);root=Path(d['supportRoot']);root.mkdir(parents=True,exist_ok=True)
assert not root.is_symlink()
with (root/'.activation.lock').open('a') as lock:
 end=time.monotonic()+30
 while True:
  try:
   fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);break
  except BlockingIOError:
   if time.monotonic()>=end:raise TimeoutError('Node support activation lock timeout')
   time.sleep(.05)
 if d.get('publishCommand'):subprocess.run(['/bin/sh','-c',d['publishCommand']],check=True)
 target=Path(d['supportDir'])
 if not target.is_dir():sys.exit(75)
 assert json.loads((target/'manifest.json').read_text())['hash']==d['supportHash']
 subprocess.run(['/bin/sh','-c',d['verifyCommand']],check=True)
 keep=set(d['references']['runHashes']);keep.add(d['supportHash'])
 paths=set(d['references']['selectionPaths']);paths.add(d['selectionPath'])
 # Read every pointer before changing anything. Unknown selection is not absence.
 for name in paths:
  try:value=Path(name).expanduser().read_text().strip()
  except FileNotFoundError:continue
  if not re.fullmatch('[a-f0-9]{64}',value):raise ValueError('Invalid node support selection: '+name)
  if name!=d['selectionPath']:keep.add(value)
 selection=Path(d['selectionPath']).expanduser();selection.parent.mkdir(parents=True,exist_ok=True)
 temporary=selection.with_name(selection.name+'.'+str(os.getpid())+'.tmp')
 try:
  temporary.write_text(d['supportHash']+'\\n');os.chmod(temporary,0o644);os.replace(temporary,selection)
 finally:
  temporary.unlink(missing_ok=True)
 removed=[]
 for bundle in root.iterdir():
  if not re.fullmatch('[a-f0-9]{64}',bundle.name) or not bundle.is_dir() or bundle.is_symlink():continue
  if bundle.name in keep or (root/'.locks'/(bundle.name+'.lock')).exists():continue
  shutil.rmtree(bundle);removed.append(bundle.name)
 print(json.dumps({'selected':d['supportHash'],'removed':removed}))
`;
  return `: farmslot-node-support-activate\npython3 -c ${shellQuote(script)} ${shellQuote(JSON.stringify(payload))}`;
}
