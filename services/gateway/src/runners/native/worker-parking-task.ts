import path from 'node:path';

import type { MachinePauseNativeRecoveryHandle } from '@farmslot/protocol';

import { execOnSlot } from '../../core/exec.js';
import { loadSlotVars } from '../../core/index.js';
import { shellQuote } from '../../core/tmux.js';

// Run on the execution node. Copy canonical task documents as bytes, without another task writer.
// Each park owns an immutable archive outside the released worktree; retries check its digest.
export const NATIVE_PARK_TASK_SCRIPT = String.raw`
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const p=JSON.parse(process.argv[1]);
function entries(root) {
 const rows=[];let bytes=0;
 function walk(dir) {
  for(const name of fs.readdirSync(dir).sort()) {
   const file=path.join(dir,name),s=fs.lstatSync(file),relative=path.relative(root,file);
   if(s.isSymbolicLink()||(!s.isDirectory()&&!s.isFile()))throw Error('Task archive contains an unsupported file type');
   if(s.isDirectory()){rows.push(['directory',relative]);walk(file);}
   else {bytes+=s.size;if(bytes>67108864)throw Error('Task archive exceeds 64 MiB');rows.push(['file',relative,s.mode&511,crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]);}
  }
 }
 if(!fs.lstatSync(root).isDirectory())throw Error('Task archive root is not a directory');
 walk(root);return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
function flush(root) {
 for(const item of fs.readdirSync(root)){const file=path.join(root,item);if(fs.lstatSync(file).isDirectory())flush(file);else{const fd=fs.openSync(file,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}}
 const fd=fs.openSync(root,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
function copy(source,destination,digest) {
 const temp=destination+'.'+process.pid+'.tmp';
 try {
  fs.cpSync(source,temp,{recursive:true,errorOnExist:true,force:false});
  if(entries(temp)!==digest)throw Error('Task changed while copying');
  flush(temp);fs.renameSync(temp,destination);
  const fd=fs.openSync(path.dirname(destination),'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 } finally {fs.rmSync(temp,{recursive:true,force:true});}
}
function parents(dir,base) {
 const relative=path.relative(base,dir);
 if(relative==='..'||relative.startsWith('../')||path.isAbsolute(relative))throw Error('Task destination leaves its workspace');
 let at=base;
 for(const part of relative.split(path.sep).filter(Boolean)) {
  at=path.join(at,part);
  if(fs.existsSync(at)){if(!fs.lstatSync(at).isDirectory())throw Error('Task destination crosses a link or file');}
  else fs.mkdirSync(at,{mode:448});
 }
}
if(p.operation==='snapshot') {
 parents(path.dirname(p.archive),p.state);
 const digest=entries(p.source);
 if(fs.existsSync(p.archive)){if(entries(p.archive)!==digest)throw Error('Parked task archive changed');}
 else {
  copy(p.source,p.archive,digest);
 }
 console.log(JSON.stringify({digest}));
} else {
 if(entries(p.archive)!==p.digest)throw Error('Parked task archive integrity changed');
 if(p.operation==='restore') {
  parents(path.dirname(p.destination),p.cwd);
  if(fs.existsSync(p.destination)) {
   if(entries(p.destination)!==p.digest)throw Error('Destination already contains a different task bundle');
  } else {
   copy(p.archive,p.destination,p.digest);
  }
 }
 console.log(JSON.stringify({digest:p.digest}));
}
`;

type Handle = MachinePauseNativeRecoveryHandle;

export async function nativeParkTaskArchive(input: {
  runSlotId: string;
  handle: Handle;
  archiveKey: string;
  taskFile?: string | null;
  operation: 'snapshot' | 'inspect' | 'restore';
}): Promise<Handle['taskBundle']> {
  const { handle } = input;
  if (!handle.stateDirectory) return undefined;
  const sourceCwd = handle.relocation?.fromCwd ?? handle.cwd;
  const directory = input.taskFile ? path.posix.dirname(input.taskFile) : undefined;
  const relativeDirectory =
    handle.taskBundle?.relativeDirectory ??
    (directory && path.posix.relative(sourceCwd, path.posix.resolve(sourceCwd, directory)));
  if (
    !relativeDirectory ||
    relativeDirectory === '..' ||
    relativeDirectory.startsWith('../') ||
    path.posix.isAbsolute(relativeDirectory)
  ) {
    if (input.operation === 'snapshot') return undefined; // An absolute task outside the worktree already survives slot recycling.
    if (!handle.taskBundle) return undefined;
    throw new Error('Native parking task archive has an invalid relative directory');
  }
  if (input.operation !== 'snapshot' && !handle.taskBundle)
    throw new Error('Native parking has no preserved task bundle');
  const archive = path.posix.join(handle.stateDirectory, 'parks', input.archiveKey, 'task');
  const params = {
    operation: input.operation,
    archive,
    state: handle.stateDirectory,
    source: path.posix.join(sourceCwd, relativeDirectory),
    cwd: handle.cwd,
    destination: path.posix.join(handle.cwd, relativeDirectory),
    digest: handle.taskBundle?.digest,
  };
  const result = await execOnSlot(
    await loadSlotVars(input.runSlotId),
    `node -e ${shellQuote(NATIVE_PARK_TASK_SCRIPT)} ${shellQuote(JSON.stringify(params))}`,
    { timeout: 30_000 },
  );
  if (result.exitCode !== 0)
    throw new Error(
      `Native parking task ${input.operation} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  const receipt = JSON.parse(result.stdout) as { digest: string };
  if (!/^[a-f0-9]{64}$/.test(receipt.digest))
    throw new Error('Native task archive returned an invalid receipt');
  return { relativeDirectory, digest: receipt.digest };
}
