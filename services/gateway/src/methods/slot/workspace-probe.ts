import { isRecord } from '@farmslot/protocol/recipe';

import type { RawProjectJson, SlotVars } from '../../core/index.js';
import { readSlotProbe } from '../../core/read-probes.js';
import { shellQuote } from '../../core/tmux.js';
import { slotScaffoldingPaths } from '../../fleet/slot-scaffolding.js';

export interface WorkspaceProbe {
  branch: string;
  headSha: string;
  dirtyFingerprint: string;
  dirtyCount: number;
  localDefaultSha: string | null;
  behind: number | null;
  defaultFetchedAt: string | null;
  originKey: string;
  publicationRemote: string;
  publicationRef: string;
}

/** One read-only process, including content hashes. No file contents cross the node boundary. */
export function workspaceProbeCommand(
  vars: Pick<SlotVars, 'remoteRepo'>,
  project: RawProjectJson,
  defaultBranch: string,
): string {
  return `GIT_OPTIONAL_LOCKS=0 python3 - ${shellQuote(vars.remoteRepo)} ${shellQuote(defaultBranch)} ${shellQuote(JSON.stringify(slotScaffoldingPaths(project).owned))} <<'FARMSLOT_WORKSPACE_PROBE'
import datetime,hashlib,json,os,pathlib,stat,subprocess,sys
repo,default,excluded=sys.argv[1],sys.argv[2],json.loads(sys.argv[3])
def git(*args,optional=False):
 p=subprocess.run(['git','-C',repo,*args],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 if p.returncode and not optional: raise RuntimeError('git '+args[0]+' failed')
 return p.stdout if p.returncode==0 else b''
branch=git('symbolic-ref','--quiet','--short','HEAD',optional=True).decode().strip() or 'HEAD'
head=git('rev-parse','--verify','HEAD').decode().strip()
entries=git('status','--porcelain','-z','--untracked-files=all').split(b'\\x00')
digest=hashlib.sha256();count=0;i=0
while i<len(entries):
 entry=entries[i];i+=1
 if not entry: continue
 name=os.fsdecode(entry[3:]);kind=entry[:2]
 if b'R' in kind or b'C' in kind:
  digest.update(entries[i]+b'\\x00');i+=1
 if kind==b'??' and any(name==x or name.startswith(x+'/') for x in excluded): continue
 count+=1;digest.update(entry+b'\\x00')
 file=pathlib.Path(repo,name)
 try:
  mode=file.lstat().st_mode;digest.update(str(mode).encode())
  if stat.S_ISLNK(mode): digest.update(os.fsencode(os.readlink(file)))
  elif stat.S_ISREG(mode):
   with file.open('rb') as stream:
    for chunk in iter(lambda:stream.read(1024*1024),b''): digest.update(chunk)
 except FileNotFoundError: digest.update(b'deleted')
for args in [('diff','--cached','--binary','--no-ext-diff','--no-textconv'),('diff','--binary','--no-ext-diff','--no-textconv')]: digest.update(git(*args))
ref='refs/remotes/origin/'+default
local=git('rev-parse','--verify',ref,optional=True).decode().strip() or None
behind=git('rev-list','--count','HEAD..'+ref,optional=True).decode().strip() if local else ''
fetch=pathlib.Path(git('rev-parse','--git-path','FETCH_HEAD').decode().strip())
if not fetch.is_absolute(): fetch=pathlib.Path(repo,fetch)
fetched=None
if fetch.is_file() and ("branch '"+default+"' of ") in fetch.read_text(errors='replace'):
 fetched=datetime.datetime.fromtimestamp(fetch.stat().st_mtime,datetime.timezone.utc).isoformat()
remote=git('config','--get','branch.'+branch+'.remote',optional=True).decode().strip() or 'origin'
merge=git('config','--get','branch.'+branch+'.merge',optional=True).decode().strip() or 'refs/heads/'+branch
origin=git('remote','get-url','origin').strip()
print(json.dumps(dict(branch=branch,headSha=head,dirtyFingerprint=digest.hexdigest(),dirtyCount=count,localDefaultSha=local,behind=int(behind) if behind.isdigit() else None,defaultFetchedAt=fetched,originKey=hashlib.sha256(origin).hexdigest(),publicationRemote=remote,publicationRef=merge)))
FARMSLOT_WORKSPACE_PROBE`;
}

export async function probeWorkspace(
  vars: SlotVars,
  project: RawProjectJson,
  defaultBranch: string,
): Promise<WorkspaceProbe> {
  const result = await readSlotProbe(
    vars,
    workspaceProbeCommand(vars, project, defaultBranch),
    'workspace',
    5000,
  );
  const data: unknown = JSON.parse(result.stdout);
  if (
    !isRecord(data) ||
    ![
      'branch',
      'headSha',
      'dirtyFingerprint',
      'originKey',
      'publicationRemote',
      'publicationRef',
    ].every((key) => typeof data[key] === 'string') ||
    typeof data.dirtyCount !== 'number' ||
    !(data.behind === null || typeof data.behind === 'number') ||
    !(data.localDefaultSha === null || typeof data.localDefaultSha === 'string') ||
    !(data.defaultFetchedAt === null || typeof data.defaultFetchedAt === 'string')
  )
    throw new Error('Invalid workspace probe result');
  return {
    branch: String(data.branch),
    headSha: String(data.headSha),
    dirtyFingerprint: String(data.dirtyFingerprint),
    dirtyCount: data.dirtyCount,
    originKey: String(data.originKey),
    publicationRemote: String(data.publicationRemote),
    publicationRef: String(data.publicationRef),
    localDefaultSha: data.localDefaultSha,
    behind: data.behind,
    defaultFetchedAt: data.defaultFetchedAt,
  };
}
