import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { isTerminalRunStatus, resolveRunSlotId, type Run } from '@farmslot/protocol';
import { isRecord } from '@farmslot/protocol/recipe';
import { parseRunRecordFile } from '@farmslot/run-bundle';
import { expandFixturePath } from '@farmslot/slot-config';

import { loadMachineSlots, loadProjectVars, loadSlotVars, type SlotVars } from '../core/config.js';
import { shellQuote } from '../core/tmux.js';
import { nodeSupportHashPath } from '../runners/runner-observability.js';

export interface NodeSupportRetentionReferences {
  selectionPaths: string[];
  runHashes: string[];
  activeRuns?: ActiveRunSupportReferences[];
  endedRunIds?: string[];
  runInventory?: RunSupportInventory;
}

export interface RunSupportInventory {
  generation: string;
  scope: string;
  runIds: string[];
}

export interface ActiveRunSupportReferences {
  runId: string;
  paths: string[];
}

export const NODE_SUPPORT_COMMAND_CACHE_MS = 10 * 60_000;
// Covers the cache window plus bounded delivery; running commands also hold a read lock.
export const NODE_SUPPORT_READER_RETAIN_MS = 2 * NODE_SUPPORT_COMMAND_CACHE_MS;

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
export async function persistedNodeSupportRuns(directory: string): Promise<Run[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  const runs: Run[] = [];
  for (const name of names.filter((name) => name.endsWith('.json'))) {
    let content: string;
    try {
      content = await readFile(path.join(directory, name), 'utf8');
    } catch (error) {
      // Archiving can remove a run after the directory inventory. It retains no bundle here.
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
    // Corrupt records have unknown references, so pruning must still fail closed.
    const record: unknown = JSON.parse(content);
    if (!isRecord(record)) throw new Error(`Unreadable node-support run references: ${name}`);
    const run = parseRunRecordFile(name, content);
    // Other stores (for example runtime-capabilities) share the run directory.
    if (run) runs.push(run);
    else if (typeof record.id === 'string' && name === `${record.id}.json`)
      throw new Error(`Unreadable node-support run references: ${name}`);
  }
  return runs;
}

const execFileAsync = promisify(execFile);

/** Fence snapshots across gateway and one-shot processes, including restarts. */
async function nextInventoryGeneration(directory: string): Promise<string> {
  const script = `import fcntl,os,sys
from pathlib import Path
root=Path(sys.argv[1]);root.mkdir(parents=True,exist_ok=True)
with (root/'.node-support-inventory.lock').open('a') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX)
 counter=root/'.node-support-inventory-generation'
 generation=int(counter.read_text())+1 if counter.exists() else 1
 temporary=counter.with_name(counter.name+'.'+str(os.getpid())+'.tmp')
 with temporary.open('w') as output:
  output.write(str(generation));output.flush();os.fsync(output.fileno())
 os.replace(temporary,counter)
 directory=os.open(root,os.O_RDONLY)
 try:os.fsync(directory)
 finally:os.close(directory)
 print(generation)
`;
  const { stdout } = await execFileAsync('python3', ['-c', script, directory], { timeout: 30_000 });
  const generation = stdout.trim();
  if (!/^[1-9][0-9]*$/.test(generation)) throw new Error('Invalid support inventory generation');
  return generation;
}

export async function nodeSupportRetentionReferences(
  vars: SlotVars,
): Promise<NodeSupportRetentionReferences> {
  // Transport probes import this module while runner observability is initializing.
  // Read the run store only for an activation, after that import graph has settled.
  const { listRuns, runsDirectory, getArchivedRuns } = await import('../runs/store.js');
  const generation = await nextInventoryGeneration(runsDirectory());
  // Loaded records win over disk while their latest status is being persisted.
  const runs = [
    ...new Map(
      [
        ...(await getArchivedRuns()),
        ...(await persistedNodeSupportRuns(runsDirectory())),
        ...listRuns().runs,
      ].map((run) => [run.id, run]),
    ).values(),
  ];
  const selectionPaths = [];
  const activeRuns: ActiveRunSupportReferences[] = [];
  for (const slot of await loadMachineSlots(vars.machine)) {
    // Disabled slots retain their selection too. An unreadable config refuses
    // pruning instead of guessing that the slot holds no bundle.
    const selected = await loadSlotVars(slot.id);
    const project = await loadProjectVars(selected.projectName);
    const selection = nodeSupportHashPath(selected.remoteRepo, project.runtimeDir);
    selectionPaths.push(selection);
    for (const run of runs) {
      if (run.archivedAt || isTerminalRunStatus(run.status) || resolveRunSlotId(run) !== slot.id)
        continue;
      const paths = [selection];
      const fixtures = project.projectJson.fixtures;
      if (isRecord(fixtures)) {
        for (const group of [fixtures.templates, fixtures.directories]) {
          if (!Array.isArray(group)) continue;
          for (const fixture of group) {
            if (!isRecord(fixture) || typeof fixture.dst !== 'string') continue;
            const destination = expandFixturePath(fixture.dst, selected, project, {
              domain: run.domain ?? selected.domain ?? '',
            });
            if (/\{\{[^}]+\}\}/.test(destination))
              throw new Error(`Cannot inspect active fixture destination on ${slot.id}`);
            paths.push(
              path.posix.isAbsolute(destination) || destination.startsWith('~/')
                ? destination
                : path.posix.join(selected.remoteRepo, destination),
            );
          }
        }
      }
      activeRuns.push({ runId: run.id, paths: [...new Set(paths)] });
    }
  }
  return {
    selectionPaths,
    activeRuns,
    runInventory: {
      generation,
      scope: createHash('sha256')
        .update(hostname())
        .update('\0')
        .update(runsDirectory())
        .digest('hex'),
      runIds: runs.map((run) => run.id),
    },
    endedRunIds: runs
      .filter((run) => run.archivedAt || isTerminalRunStatus(run.status))
      .map((run) => run.id),
    runHashes: referencedNodeSupportHashes(runs),
  };
}

export interface NodeSupportActivationParams {
  supportDir: string;
  supportHash: string;
  selectionPath?: string;
  readerTtlMs?: number;
  references: NodeSupportRetentionReferences;
  publishCommand?: string;
  verifyCommand: string;
}

/** Publish, verify, select and prune under one node-owned lock, including other gateways. */
export function buildNodeSupportActivationCommand(params: NodeSupportActivationParams): string {
  const payload = { ...params, supportRoot: path.posix.dirname(params.supportDir) };
  const script = `import fcntl,hashlib,json,os,re,shutil,subprocess,sys,time
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
 readers=root/'.readers';readers.mkdir(exist_ok=True)
 if d.get('readerTtlMs'):
  lease=readers/(d['supportHash']+'.json')
  previous=json.loads(lease.read_text())['expiresAt'] if lease.exists() else 0
  temporary=lease.with_name(lease.name+'.'+str(os.getpid())+'.tmp')
  temporary.write_text(json.dumps({'expiresAt':max(previous,time.time()+d['readerTtlMs']/1000)}));os.replace(temporary,lease)
  print(json.dumps({'reader':d['supportHash']}));sys.exit(0)
 keep=set(d['references']['runHashes']);keep.add(d['supportHash'])
 active=root/'.active-run-references';active.mkdir(exist_ok=True)
 inventory=d['references'].get('runInventory',{})
 pattern=re.compile(rb'/farmslot-node/support/([a-f0-9]{64})(?=$|[\\s/"\\x27\\x5c])')
 def inspect(reference,hashes):
  try:
   if reference.is_symlink():
    hashes.update(m.decode() for m in pattern.findall(os.fsencode(os.readlink(reference))));return
   if reference.is_dir():
    for child in reference.iterdir():inspect(child,hashes)
    return
   if not reference.is_file():return
   with reference.open('rb') as source:
    tail=b''
    while True:
     chunk=source.read(65536)
     if not chunk:break
     data=tail+chunk
     hashes.update(m.decode() for m in pattern.findall(data))
     if re.fullmatch(rb'[a-f0-9]{64}',data.strip()):hashes.add(data.strip().decode())
     tail=data[-256:]
  except FileNotFoundError:
   return # A fixture may be replaced during sync; prior observations remain retained.
 for run in d['references'].get('activeRuns',[]):
  name=hashlib.sha256(run['runId'].encode()).hexdigest()+'.json'
  record=active/name
  previous=json.loads(record.read_text()) if record.exists() else {}
  hashes=set(previous.get('hashes',[]))
  generation=int(inventory.get('generation','0'))
  if previous.get('scope')==inventory.get('scope'):generation=max(generation,int(previous.get('generation','0')))
  for reference in run['paths']:inspect(Path(reference).expanduser(),hashes)
  if any(not re.fullmatch('[a-f0-9]{64}',value) for value in hashes):raise ValueError('Invalid active support reference')
  temporary=record.with_name(record.name+'.'+str(os.getpid())+'.tmp')
  temporary.write_text(json.dumps({'runId':run['runId'],'hashes':sorted(hashes),'scope':inventory.get('scope'),'generation':str(generation)}));os.replace(temporary,record)
  keep.update(hashes)
 # Absence from another caller's inventory is not evidence that a run ended.
 for record in active.glob('*.json'):
  saved=json.loads(record.read_text())
  same=inventory.get('scope') and saved.get('scope')==inventory['scope']
  newer=same and int(inventory['generation'])>int(saved.get('generation','0'))
  ended=saved['runId'] in d['references'].get('endedRunIds',[])
  deleted=same and saved['runId'] not in inventory['runIds']
  if (ended or deleted) and (newer or not saved.get('scope')):record.unlink()
  else:keep.update(saved['hashes'])
 for lease in readers.glob('*.json'):
  if not re.fullmatch('[a-f0-9]{64}\\.json',lease.name):continue
  if json.loads(lease.read_text())['expiresAt']>time.time():keep.add(lease.stem)
  else:lease.unlink()
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

/** A cached read keeps its files through execution, even if its cache lease expires meanwhile. */
export function wrapNodeSupportReadCommand(command: string, supportDir: string): string {
  const script = `import fcntl,json,os,signal,subprocess,sys
from pathlib import Path
d=json.loads(sys.argv[1]);bundle=Path(d['supportDir'])
with (bundle.parent/'.activation.lock').open('a') as lock:
 fcntl.flock(lock,fcntl.LOCK_SH)
 if not bundle.is_dir():raise RuntimeError('Read-only node support bundle is unavailable')
 shell=sys.argv[2]
 flags={'zsh':['-f'],'bash':['--noprofile','--norc']}.get(Path(shell).name,[])
 result=subprocess.run([shell,*flags,'-c',d['command']])
 if result.returncode<0:
  if -result.returncode!=signal.SIGKILL:signal.signal(-result.returncode,signal.SIG_DFL)
  os.kill(os.getpid(),-result.returncode)
 sys.exit(result.returncode)
`;
  return `python3 -c ${shellQuote(script)} ${shellQuote(JSON.stringify({ command, supportDir }))} "$0"`;
}
