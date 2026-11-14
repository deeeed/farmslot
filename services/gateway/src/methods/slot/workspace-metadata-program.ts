import { shellQuote } from '../../core/tmux.js';

import {
  WORKSPACE_METADATA_POLICY,
  type WorkspaceMetadataVersion,
} from './workspace-metadata-policy.js';

export interface WorkspaceMetadataRoot {
  slotId: string;
  machine: string;
  repo: string;
  defaultBranch: string;
  previous?: WorkspaceMetadataVersion;
}

/** Trusted passive probe, like workspace-probe. General node filesystem .git access stays denied. */
export function workspaceMetadataCommand(roots: readonly WorkspaceMetadataRoot[]): string {
  return `python3 - ${shellQuote(JSON.stringify(roots))} ${shellQuote(JSON.stringify(WORKSPACE_METADATA_POLICY))} <<'FARMSLOT_WORKSPACE_METADATA'
import json,os,pathlib,stat,sys
policy=json.loads(sys.argv[2])

def version(root):
 repo,default=root['repo'],root['defaultBranch']
 marker=pathlib.Path(repo,policy['marker'])
 if not marker.exists(): return None
 info=marker.lstat()
 gitdir=marker
 if stat.S_ISREG(info.st_mode):
  pointer=marker.read_text().strip()
  prefix=policy['gitPointerPrefix']
  if not pointer.startswith(prefix) or not pointer[len(prefix):]: return None
  gitdir=pathlib.Path(pointer[len(prefix):])
  if not gitdir.is_absolute(): gitdir=pathlib.Path(repo,gitdir)
 elif not stat.S_ISDIR(info.st_mode): return None
 head=pathlib.Path(gitdir,policy['head']).read_text().strip()
 if head==policy['reftableHead']: return None
 commonfile=pathlib.Path(gitdir,policy['commonDirectory'])
 common=pathlib.Path(commonfile.read_text().strip()) if commonfile.exists() else gitdir
 if not common.is_absolute(): common=pathlib.Path(gitdir,common)
 target=head[len(policy['symbolicHeadPrefix']):] if head.startswith(policy['symbolicHeadPrefix']) else ''
 ref=target if target.startswith(policy['refRootPrefix']) and len(target)>len(policy['refRootPrefix']) else None
 reffile=pathlib.Path(common,ref) if ref else None
 refvalue=reffile.read_text() if reffile and reffile.exists() else None
 metadata=[]
 for entry in policy['files']:
  directory=gitdir if entry['directory']=='git' else common
  file=pathlib.Path(directory,entry['path'],default) if entry.get('appendDefaultBranch') else pathlib.Path(directory,entry['path'])
  if not file.exists(): metadata.append(None)
  else:
   value=file.lstat();metadata.append([value.st_mtime_ns/1000000,value.st_size])
 fingerprint=json.dumps([root['machine'],repo,default,os.path.normpath(gitdir),os.path.normpath(common),info.st_mtime_ns/1000000,info.st_size,head,refvalue,metadata],separators=(',',':'))
 previous=root.get('previous')
 if previous and previous.get('version')==fingerprint: return previous
 cacheable=all(not entry.get('blocksAncestryCache') or metadata[index] is None for index,entry in enumerate(policy['files']))
 packed_index=next(index for index,entry in enumerate(policy['files']) if entry['directory']=='common' and entry['path']==policy['packedRefs'])
 if cacheable and metadata[packed_index] is not None:
  with pathlib.Path(common,policy['packedRefs']).open() as stream:
   for line in stream:
    if line.startswith(('#','^')): continue
    fields=line.split()
    if len(fields)==2 and fields[1].startswith(policy['replacementRefs']+'/'):
     cacheable=False;break
 value=dict(version=fingerprint,ancestryCacheable=cacheable)
 alternates_index=next(index for index,entry in enumerate(policy['files']) if entry['directory']=='common' and entry['path']==policy['alternates'])
 if metadata[alternates_index] is not None: value['alternatesPath']=os.path.normpath(pathlib.Path(common,policy['alternates']))
 return value

rows=[]
for root in json.loads(sys.argv[1]):
 try: value=version(root)
 except OSError:
  # Optional metadata cannot justify reuse. The full inspection reports the actual failure.
  value=None
 rows.append(dict(slotId=root['slotId'],version=value['version'] if value else None,ancestryCacheable=value['ancestryCacheable'] if value else False,**({'alternatesPath':value['alternatesPath']} if value and 'alternatesPath' in value else {})))
print(json.dumps(rows))
FARMSLOT_WORKSPACE_METADATA`;
}
