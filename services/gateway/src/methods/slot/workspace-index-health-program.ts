/** Doctor-only read. No Git processes, object traversal, network, or index writes. */
export const WORKSPACE_INDEX_HEALTH_PROGRAM = String.raw`
import hashlib,mmap,struct
object_results={}
index_results={}

def missing_objects(objects,oids,seen=None):
 objects=objects.resolve();store=str(objects)
 missing={oid for oid in oids if not object_results.get((store,oid),False)}
 unknown={oid for oid in missing if (store,oid) not in object_results}
 visited=set() if seen is None else seen
 if store in visited: return missing
 visited.add(store)
 for oid in list(unknown):
  hexid=oid.hex()
  if (objects/hexid[:2]/hexid[2:]).is_file(): unknown.remove(oid);missing.remove(oid)
 if unknown:
  pack=objects/'pack'
  files=sorted(pack.glob('*.idx'))
  for file in files:
   if not file.with_suffix('.pack').is_file(): raise ValueError('missing pack for index: '+str(file))
   # Bound descriptors even when a repository has hundreds of pack files.
   with file.open('rb') as stream, mmap.mmap(stream.fileno(),0,access=mmap.ACCESS_READ) as data:
    if data[:8]!=b'\xfftOc\x00\x00\x00\x02': raise ValueError('unsupported pack index: '+str(file))
    total=struct.unpack_from('>I',data,8+255*4)[0]
    if len(data)<1032+total*28+40: raise ValueError('truncated pack index: '+str(file))
    for oid in list(unknown):
     bucket=oid[0]
     low=struct.unpack_from('>I',data,8+(bucket-1)*4)[0] if bucket else 0
     high=struct.unpack_from('>I',data,8+bucket*4)[0]
     while low<high:
      middle=(low+high)//2;candidate=data[1032+middle*20:1032+(middle+1)*20]
      if candidate==oid: unknown.remove(oid);missing.remove(oid);break
      if candidate<oid: low=middle+1
      else: high=middle
   if not unknown: break
 alternates=objects/'info/alternates'
 if unknown and alternates.exists():
  for line in alternates.read_text().splitlines():
   if not line: continue
   alternate=pathlib.Path(line)
   if not alternate.is_absolute(): alternate=objects/alternate
   remaining=missing_objects(alternate,unknown,visited)
   missing.difference_update(unknown-remaining);unknown=remaining
   if not unknown: break
 for oid in oids: object_results[(store,oid)]=oid not in missing
 return missing

def cache_tree_oids(data):
 if len(data)<32 or data[:4]!=b'DIRC': raise ValueError('invalid index header')
 if hashlib.sha1(data[:-20]).digest()!=data[-20:]: raise ValueError('invalid or unsupported index checksum')
 version,count=struct.unpack_from('>II',data,4)
 if version not in (2,3,4): raise ValueError('unsupported index version '+str(version))
 offset=12
 for _ in range(count):
  start=offset
  flags=struct.unpack_from('>H',data,start+60)[0]
  offset=start+62+(2 if flags&0x4000 else 0)
  if version==4:
   while data[offset]&0x80: offset+=1
   offset+=1
  offset=data.index(b'\0',offset)+1
  if version!=4: offset=start+((offset-start+7)//8)*8
 trees=[]
 while offset<len(data)-20:
  kind=data[offset:offset+4];size=struct.unpack_from('>I',data,offset+4)[0]
  end=offset+8+size
  if end>len(data)-20: raise ValueError('truncated index extension')
  if kind==b'TREE':
   tree=data[offset+8:end];cursor=0
   while cursor<len(tree):
    cursor=tree.index(b'\0',cursor)+1
    newline=tree.index(b'\n',cursor)
    entries,children=map(int,tree[cursor:newline].split(b' '))
    cursor=newline+1
    if children<0: raise ValueError('invalid cache-tree child count')
    if entries>=0:
     if cursor+20>len(tree): raise ValueError('truncated cache-tree object')
     trees.append(tree[cursor:cursor+20]);cursor+=20
  offset=end
 if offset!=len(data)-20: raise ValueError('invalid index extension boundary')
 return trees

def index_health(gitdir,common):
 errors=[];warnings=[]
 # Include registered scratch/prunable worktrees. Git fsck checks their indexes too.
 gitdir=gitdir.resolve();common=common.resolve()
 indexes={gitdir/'index',common/'index'}
 worktrees=common/'worktrees'
 if worktrees.exists(): indexes.update(entry/'index' for entry in worktrees.iterdir() if entry.is_dir())
 for index in sorted(indexes):
  if index in index_results:
   prior_errors,prior_warnings=index_results[index]
   errors.extend(prior_errors);warnings.extend(prior_warnings);continue
  first_error,first_warning=len(errors),len(warnings)
  try:
   data=index.read_bytes()
  except FileNotFoundError:
   continue
  except OSError as error:
   warnings.append(str(index)+': '+str(error));continue
  try:
   for oid in sorted(missing_objects(common/'objects',set(cache_tree_oids(data)))):
    errors.append(str(index)+': missing cache-tree object '+oid.hex())
  except (ValueError,IndexError,struct.error,OSError) as error:
   warnings.append(str(index)+': '+str(error))
  index_results[index]=(errors[first_error:],warnings[first_warning:])
 return dict(indexErrors=errors,indexWarnings=warnings)
`;
