import { shellQuote } from '../../core/tmux.js';

export interface WorkspaceMetadataRoot {
  slotId: string;
  machine: string;
  repo: string;
  defaultBranch: string;
}

/** Trusted passive probe, like workspace-probe. General node filesystem .git access stays denied. */
export function workspaceMetadataCommand(roots: readonly WorkspaceMetadataRoot[]): string {
  return `python3 - ${shellQuote(JSON.stringify(roots))} <<'FARMSLOT_WORKSPACE_METADATA'
import json,os,pathlib,re,stat,sys

def version(root):
 repo,default=root['repo'],root['defaultBranch']
 marker=pathlib.Path(repo,'.git')
 if not marker.exists(): return None
 info=marker.lstat()
 gitdir=marker
 if stat.S_ISREG(info.st_mode):
  pointer=re.fullmatch(r'gitdir: (.+)',marker.read_text().strip())
  if not pointer: return None
  gitdir=pathlib.Path(pointer[1])
  if not gitdir.is_absolute(): gitdir=pathlib.Path(repo,gitdir)
 elif not stat.S_ISDIR(info.st_mode): return None
 head=pathlib.Path(gitdir,'HEAD').read_text().strip()
 if head=='ref: refs/heads/.invalid': return None
 commonfile=pathlib.Path(gitdir,'commondir')
 common=pathlib.Path(commonfile.read_text().strip()) if commonfile.exists() else gitdir
 if not common.is_absolute(): common=pathlib.Path(gitdir,common)
 ref=re.fullmatch(r'ref: (refs/.+)',head)
 reffile=pathlib.Path(common,ref[1]) if ref else None
 refvalue=reffile.read_text() if reffile and reffile.exists() else None
 metadata=[]
 for file in [pathlib.Path(gitdir,'index'),pathlib.Path(common,'packed-refs'),pathlib.Path(common,'config'),pathlib.Path(common,'refs/remotes/origin',default),pathlib.Path(gitdir,'FETCH_HEAD')]:
  if not file.exists(): metadata.append(None)
  else:
   value=file.lstat();metadata.append([value.st_mtime_ns/1000000,value.st_size])
 return json.dumps([root['machine'],repo,default,os.path.normpath(gitdir),os.path.normpath(common),info.st_mtime_ns/1000000,info.st_size,head,refvalue,metadata],separators=(',',':'))

rows=[]
for root in json.loads(sys.argv[1]):
 try: value=version(root)
 except OSError:
  # Optional metadata cannot justify reuse. The full inspection reports the actual failure.
  value=None
 rows.append(dict(slotId=root['slotId'],version=value))
print(json.dumps(rows))
FARMSLOT_WORKSPACE_METADATA`;
}
