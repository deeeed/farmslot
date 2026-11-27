// Node's rename replaces existing paths. Walk checkout parents with directory handles
// and publish each pre-bound entry with the host's exclusive rename.
const PUBLISH_REVIEW_PATHS = String.raw`
import ctypes, errno, json, os, sys
libc = ctypes.CDLL(None, use_errno=True)
if sys.platform not in ('darwin', 'linux'):
    raise RuntimeError('Exclusive review publication requires macOS or Linux')
darwin = sys.platform == 'darwin'
rename = libc.renameatx_np if darwin else libc.renameat2
rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
rename.restype = ctypes.c_int
# RENAME_EXCL on macOS and RENAME_NOREPLACE on Linux.
exclusive = 4 if darwin else 1
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
source = os.open(sys.argv[1], flags)
checkout = os.open(sys.argv[2], flags)
stage = os.open('..', flags, dir_fd=source)
workspace = os.open('..', flags, dir_fd=stage)
entries = json.loads(sys.argv[3])
parents = []
moved = []

def parent_of(parts):
    parent = os.dup(checkout)
    try:
        for part in parts[:-1]:
            child = os.open(part, flags, dir_fd=parent)
            os.close(parent)
            parent = child
        return parent
    except OSError:
        os.close(parent)
        raise

def move(from_parent, name, to_parent, dest):
    if rename(from_parent, os.fsencode(name), to_parent, os.fsencode(dest), exclusive):
        code = ctypes.get_errno()
        raise OSError(code, errno.errorcode.get(code, os.strerror(code)), dest)

def identity(stat):
    return [str(stat.st_dev), str(stat.st_ino)]

def at(parent, name):
    return os.stat(name, dir_fd=parent, follow_symlinks=False)

def rollback_receipt(receipt, receipt_identity):
    try:
        move(workspace, receipt, stage, '.rollback-receipt')
    except FileNotFoundError:
        return  # The published receipt is already gone.
    if identity(at(stage, '.rollback-receipt')) != receipt_identity:
        move(stage, '.rollback-receipt', workspace, receipt)
        raise OSError('Review publication receipt identity changed')

def verify_paths():
    for entry, parts, parent in moved:
        current = parent_of(parts)
        try:
            if identity(os.fstat(current)) != identity(os.fstat(parent)):
                raise RuntimeError('Review publication parent changed: ' + entry['relative'])
        finally:
            os.close(current)
        name = parts[-1]
        if entry['relative'] == 'temp':
            if identity(at(parent, name)) != entry['identity'][:2]:
                raise RuntimeError('Review task parent identity changed')
            child = os.open(name, flags, dir_fd=parent)
            try:
                if identity(at(child, 'tasks')) != entry['linkIdentity'][:2]:
                    raise RuntimeError('Review task link identity changed')
            finally:
                os.close(child)
        elif identity(at(parent, name)) != entry['linkIdentity'][:2]:
            raise RuntimeError('Review publication link identity changed: ' + entry['relative'])
    if identity(at(workspace, os.path.basename(sys.argv[2]))) != identity(os.fstat(checkout)):
        raise RuntimeError('Review publication checkout changed')

receipt = sys.argv[4]
receipt_identity = identity(at(stage, '.receipt.json'))
receipt_published = False
try:
    for entry in entries:
        parts = entry['relative'].split('/')
        parent = parent_of(parts)
        parents.append(parent)
        move(source, entry['name'], parent, parts[-1])
        moved.append((entry, parts, parent))
    verify_paths()
    os.link('.receipt.json', receipt, src_dir_fd=stage, dst_dir_fd=workspace, follow_symlinks=False)
    receipt_published = True
    verify_paths()
    if identity(at(workspace, receipt)) != receipt_identity:
        raise RuntimeError('Review publication receipt identity changed')
except Exception:
    failures = []
    if receipt_published:
        try:
            rollback_receipt(receipt, receipt_identity)
        except OSError as error:
            failures.append(str(error))
    for entry, parts, parent in reversed(moved):
        try:
            expected = entry.get('identity', entry['linkIdentity'])[:2]
            if identity(at(parent, parts[-1])) != expected:
                raise OSError('Review publication identity changed: ' + entry['relative'])
            move(parent, parts[-1], source, entry['name'])
        except OSError as error:
            failures.append(str(error))
    if failures:
        raise RuntimeError('Review publication rollback incomplete: ' + ', '.join(failures))
    raise
finally:
    for parent in parents:
        os.close(parent)
    os.close(workspace)
    os.close(stage)
    os.close(checkout)
    os.close(source)
`;

/** Runs on the execution node after the frozen skill bundle has been verified. */
export const REVIEW_SKILL_INSTALL_SCRIPT = String.raw`
const fs=require('node:fs'),path=require('node:path');
const input=JSON.parse(process.argv[1]);
if(input.action==='cleanup'&&!fs.existsSync(input.checkout)){process.stdout.write('{}');process.exit(0);}
if(fs.lstatSync(input.checkout).isSymbolicLink())throw Error('Review checkout is symlinked');
const checkout=fs.realpathSync(input.checkout);
function exists(file){try{return fs.lstatSync(file);}catch(e){if(e.code==='ENOENT')return undefined;throw e;}}
function within(root,file){const p=path.relative(root,file);return p===''||(!p.startsWith('..'+path.sep)&&p!=='..'&&!path.isAbsolute(p));}
function directory(file){
 if(!within(checkout,file))throw Error('Skill path escapes checkout');
 const st=exists(file);
 if(!st){if(input.verifyOnly)throw Error('Review skill installation missing');directory(path.dirname(file));fs.mkdirSync(file);}
 if(!fs.statSync(file).isDirectory()||!within(checkout,fs.realpathSync(file)))throw Error('Review skill directory escapes checkout');
}
function link(file,target){
 const st=exists(file);
 if(st){if(!st.isSymbolicLink()||path.resolve(path.dirname(file),fs.readlinkSync(file))!==target)throw Error('Conflicting review skill: '+file);}
 else{if(input.verifyOnly)throw Error('Review skill link missing');fs.symlinkSync(target,file);}
}
// ADR-058 Amendment 4: a skill installed by its repository's tools/install, as an engineer does.
// Its rounds are written in <workspace>/review-tasks, which the checkout's temp/tasks links to,
// so the checkout itself stays read-only for the reviewer.
const TASK_LINK='../../review-tasks';
function installCheck(install){
 if(!/^[a-z0-9][a-z0-9._-]*$/.test(install.repo)||!/^[a-z0-9-]+\/[a-z0-9-]+$/.test(install.include)||!/^mms-[a-z0-9-]+$/.test(install.installedName))throw Error('Invalid review skill install');
 return ['.agents/skills','.claude/skills','.cursor/rules'].map(dir=>path.join(checkout,dir,install.installedName));
}
const cp=require('node:child_process');
function ignoreCheckoutPaths(patterns){
 const exclude=cp.spawnSync('git',['-C',checkout,'rev-parse','--path-format=absolute','--git-path','info/exclude'],{encoding:'utf8'});
 if(exclude.status!==0)throw Error('Review checkout has no Git exclude file');
 const file=exclude.stdout.trim(),text=exists(file)?fs.readFileSync(file,'utf8'):'';
 const missing=patterns.filter(pattern=>!text.split('\n').includes(pattern));
 if(missing.length){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.appendFileSync(file,(text&&!text.endsWith('\n')?'\n':'')+missing.join('\n')+'\n');
 }
}
function verifyUntracked(paths){
 const tracked=cp.spawnSync('git',['-C',checkout,'ls-files','-z','--',...paths.map(dir=>path.relative(checkout,dir))],{encoding:'utf8'});
 if(tracked.status!==0||tracked.stdout)throw Error('Review skill installation would overwrite tracked files');
}
const statIdentity=st=>[String(st.dev),String(st.ino),String(st.birthtimeNs)];
function directoryIdentity(dir){
 const st=fs.lstatSync(dir,{bigint:true});
 if(!st.isDirectory()||st.isSymbolicLink()||fs.realpathSync(dir)!==dir)throw Error('Review skill destination is not an owned directory');
 return statIdentity(st);
}
const sameIdentity=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
function retireOwnedPath(file,verify){
 if(!exists(file))return;
 const staging=fs.mkdtempSync(path.join(path.dirname(checkout),'.review-skill-retire-'));
 const staged=path.join(staging,'directory');
 try{fs.renameSync(file,staged);}
 catch(error){fs.rmdirSync(staging);throw error;}
 try{verify(staged);}
 catch(error){throw Error(error.message+'; preserved at '+staged);}
 fs.rmSync(staged,{recursive:true});
 fs.rmdirSync(staging);
}
function verifyTree(owner,root=owner.stage){
 if(!sameIdentity(directoryIdentity(root),owner.identity))throw Error('Review skill destination identity changed');
 for(const [relative,identity] of Object.entries(owner.directories)){
  const dir=path.join(root,relative);
  if(!within(root,dir)||!sameIdentity(directoryIdentity(dir),identity))throw Error('Review skill destination identity changed');
 }
}
function aliasIdentity(file,target){
 const st=fs.lstatSync(file,{bigint:true});
 if(!st.isSymbolicLink()||fs.readlinkSync(file)!==target)throw Error('Review skill publication destination already exists: '+file);
 return statIdentity(st);
}
function verifyPublication(file,publication){
 if(publication.relative==='temp'){
  if(!sameIdentity(directoryIdentity(file),publication.identity)||!sameIdentity(fs.readdirSync(file),['tasks']))
   throw Error('Review task parent directory identity changed');
  file=path.join(file,'tasks');
 }
 if(!sameIdentity(aliasIdentity(file,publication.target),publication.linkIdentity))
  throw Error('Review skill publication link identity changed');
}
function retirePublication(publication){
 retireOwnedPath(path.join(checkout,publication.relative),staged=>verifyPublication(staged,publication));
}
function retireSkill(owner){
 if(exists(owner.stage))retireOwnedPath(owner.stage,staged=>verifyTree(owner,staged));
}
function publicationPath(destination){
 let current=checkout;
 for(const part of path.relative(checkout,destination).split(path.sep)){
  current=path.join(current,part);
  if(!exists(current))return path.relative(checkout,current);
  if(current===destination)throw Error('Review skill destination already exists without an owner');
  directoryIdentity(current);
 }
 throw Error('Invalid review skill destination');
}
const PUBLISH=${JSON.stringify(PUBLISH_REVIEW_PATHS)};
const installerSkills=input.skills.filter(skill=>skill.install);
const installers=installerSkills.map(skill=>skill.install);
const destinations=installers.flatMap(installCheck);
const marker=installers.length&&path.join(path.dirname(checkout),'.installed-review-skill-'+installers[0].installedName+'.json');
function readOwner(){
 const state=marker&&exists(marker);
 if(!state)return undefined;
 if(!state.isFile())throw Error('Invalid review skill ownership record');
 const owner=JSON.parse(fs.readFileSync(marker,'utf8'));
 if(!sameIdentity(owner.installers,installers)||path.dirname(owner.stage)!==path.dirname(checkout)||!path.basename(owner.stage).startsWith('.review-skills-'))
  throw Error('Invalid review skill ownership record');
 const relative=destinations.map(dir=>path.relative(checkout,dir));
 const allowed=new Set(relative.flatMap(dir=>[dir,path.dirname(dir),path.dirname(path.dirname(dir))]));
 if(!Array.isArray(owner.publications)||
    !owner.publications.every(entry=>allowed.has(entry.relative)
      ? entry.target===path.join(owner.stage,entry.relative)
      : ['temp','temp/tasks'].includes(entry.relative)&&entry.target===TASK_LINK)||
    !sameIdentity(Object.keys(owner.directories??{}).sort(),[...new Set(relative)].sort()))
  throw Error('Invalid review skill ownership paths');
 return owner;
}
function stagedInstallPaths(stage,install){
 return installCheck(install).map(dir=>path.join(stage,path.relative(checkout,dir)));
}
function verifyInstalled(stage){
 for(const install of installers){
  const [agents,claude,cursor]=stagedInstallPaths(stage,install);
  const cursorRule=['RULE.md',install.installedName+'.mdc'].map(name=>path.join(cursor,name)).find(file=>exists(file));
  for(const file of [path.join(agents,'SKILL.md'),path.join(agents,'scripts','review-task.mjs'),path.join(claude,'SKILL.md'),cursorRule]){
   const st=file&&exists(file);
   if(!st?.isFile()||!st.size||fs.realpathSync(file)!==file||!within(stage,file))
    throw Error('Review skill installation missing required staged output: '+(file??cursor));
  }
 }
}
function prepareInstaller(){
 const prior=readOwner();
 if(prior){
  verifyTree(prior);
  verifyInstalled(prior.stage);
  const hasTasks=prior.publications.some(entry=>entry.target===TASK_LINK);
  if(hasTasks!==Boolean(input.reviewTasks))throw Error('Review task publication changed');
  for(const publication of prior.publications)verifyPublication(path.join(checkout,publication.relative),publication);
  return;
 }
 if(input.verifyOnly)throw Error('Review skill installation missing its ownership record');
 const aliases=[...new Set(destinations.map(publicationPath))];
 const taskRelative=input.reviewTasks&&publicationPath(path.join(checkout,'temp','tasks'));
 verifyUntracked([...aliases,...(taskRelative?[taskRelative]:[])].map(relative=>path.join(checkout,relative)));

 const stage=fs.mkdtempSync(path.join(path.dirname(checkout),'.review-skills-'));
 // Until every identity is bound, this is an unclaimed stage. Workspace cleanup owns it.
 const owner={installers,stage,identity:directoryIdentity(stage),publications:[],directories:{}};
 try{
  for(const install of installers){
   const result=cp.spawnSync('bash',[path.join(install.source,'tools','install'),'--repo',install.repo,'--target',stage,'--source',install.source,'--include',install.include],{encoding:'utf8'});
   if(result.status!==0)throw Error('tools/install failed: '+String(result.stderr||result.stdout||result.error).slice(-2000));
  }
  verifyInstalled(stage);
 }catch(error){
  retireSkill(owner);
  throw error;
 }
 for(const dest of destinations){
  const relative=path.relative(checkout,dest);
  owner.directories[relative]=directoryIdentity(path.join(stage,relative));
 }
 const publicationRoot=path.join(stage,'.publication');
 fs.mkdirSync(publicationRoot);
 for(const relative of [...aliases,...(taskRelative?[taskRelative]:[])]){
  const target=relative===taskRelative?TASK_LINK:path.join(stage,relative);
  const name=String(owner.publications.length);
  const source=path.join(publicationRoot,name);
  if(relative==='temp'){
   fs.mkdirSync(source);
   const file=path.join(source,'tasks');
   fs.symlinkSync(target,file,'dir');
   owner.publications.push({name,relative,target,identity:directoryIdentity(source),linkIdentity:aliasIdentity(file,target)});
  }else{
   fs.symlinkSync(target,source,'dir');
   owner.publications.push({name,relative,target,linkIdentity:aliasIdentity(source,target)});
  }
 }
 try{
  if(taskRelative){
   const taskRoot=path.join(path.dirname(checkout),'review-tasks');
   fs.mkdirSync(taskRoot,{recursive:true});
   directoryIdentity(taskRoot);
   ignoreCheckoutPaths(['/temp/tasks']);
  }
  const pending=path.join(stage,'.receipt.json');
  fs.writeFileSync(pending,JSON.stringify(owner),{flag:'wx',mode:0o600});
  const result=cp.spawnSync('python3',
   ['-I','-c',PUBLISH,publicationRoot,checkout,JSON.stringify(owner.publications),path.basename(marker)],
   {encoding:'utf8'});
  if(result.status!==0)throw Error('Review publication failed: '+(result.stderr?.trim()||result.error?.message||result.status));
 }catch(error){
  // The publisher returns moved entries through the original directory handles.
  // If it returned foreign bytes or left a move incomplete, preserve the stage for recovery.
  try{
   const pending=path.join(stage,'.receipt.json'),returned=path.join(stage,'.rollback-receipt');
   if(exists(pending)){
    const identity=statIdentity(fs.lstatSync(pending,{bigint:true}));
    if(exists(marker)&&sameIdentity(statIdentity(fs.lstatSync(marker,{bigint:true})),identity))
     throw Error('Review publication receipt remains linked');
    if(exists(returned)&&!sameIdentity(statIdentity(fs.lstatSync(returned,{bigint:true})),identity))
     throw Error('Review publication rollback returned a foreign receipt');
   }
   for(const publication of owner.publications)
    verifyPublication(path.join(publicationRoot,publication.name),publication);
  }catch(problem){
   const recovery=fs.mkdtempSync(path.join(path.dirname(checkout),'.review-skill-retire-'));
   fs.renameSync(stage,path.join(recovery,'stage'));
   throw Error(error.message+'; install rollback preserved at '+recovery+': '+problem.message);
  }
  retireSkill(owner);
  throw error;
 }
}
if(input.action==='cleanup'){
 // A failed retirement preserves the unexpected directory for operator recovery.
 if(fs.readdirSync(path.dirname(checkout)).some(name=>name.startsWith('.review-skill-retire-')))
  throw Error('Review skill cleanup has a preserved directory awaiting recovery');
 const links=[],directories=[];
 const owner=readOwner();
 if(owner){
  verifyUntracked(owner.publications.map(entry=>path.join(checkout,entry.relative)));
  for(const publication of owner.publications)retirePublication(publication);
  retireSkill(owner);
  fs.unlinkSync(marker);
 }
 for(const skill of input.skills.filter(skill=>!skill.install)){
  if(!/^[a-zA-Z0-9_-]+$/.test(skill.name))throw Error('Invalid review skill name');
  const root=path.join(checkout,'.agents','skills',skill.name),source=path.dirname(skill.path);
  if(exists(root)){
   if(!fs.lstatSync(root).isDirectory()||fs.realpathSync(root)!==root)throw Error('Review skill directory changed');
   for(const name of fs.readdirSync(root)){
    const file=path.join(root,name),st=fs.lstatSync(file),target=st.isSymbolicLink()?path.resolve(root,fs.readlinkSync(file)):undefined;
    if(target!==path.join(source,name)&&!(name==='SKILL.md'&&target===skill.path))throw Error('Review skill changed; refusing cleanup');
    links.push(file);
   }
   directories.push(root);
  }
  for(const surface of ['.claude','.cursor']){
   const parent=path.join(checkout,surface,'skills'),file=path.join(parent,skill.name),st=exists(file);
   if(st){if(!st.isSymbolicLink()||path.resolve(parent,fs.readlinkSync(file))!==root)throw Error('Review skill alias changed');links.push(file);}
  }
 }
 for(const file of links)fs.unlinkSync(file);
 for(const dir of directories)fs.rmdirSync(dir);
 for(const surface of ['.agents','.claude','.cursor'])for(const dir of [path.join(checkout,surface,'skills'),path.join(checkout,surface)]){
  if(exists(dir)&&fs.lstatSync(dir).isDirectory()&&fs.readdirSync(dir).length===0)fs.rmdirSync(dir);
 }
 process.stdout.write(JSON.stringify({cleaned:true}));process.exit(0);
}
if(input.reviewTasks&&input.reviewTasks!==path.join(path.dirname(input.checkout),'review-tasks'))throw Error('Invalid review task root');
if(input.reviewTasks&&!installerSkills.length)throw Error('Review task publication requires an installed skill');
const installed=[];
for(const skill of input.skills.filter(skill=>!skill.install)){
 if(!/^[a-zA-Z0-9_-]+$/.test(skill.name))throw Error('Invalid review skill name');
 const source=path.dirname(skill.path),root=path.join(checkout,'.agents','skills',skill.name);
 directory(root);
 const names=fs.readdirSync(source);
 for(const name of names)link(path.join(root,name),path.join(source,name));
 if(!names.includes('SKILL.md'))link(path.join(root,'SKILL.md'),skill.path);
 const expected=new Set([...names,'SKILL.md']);
 if(fs.readdirSync(root).some(name=>!expected.has(name)))throw Error('Unexpected review skill file');
 for(const surface of ['.claude','.cursor']){
  const parent=path.join(checkout,surface,'skills');directory(parent);link(path.join(parent,skill.name),root);
 }
 installed.push(skill.name);
}
if(installerSkills.length){
 for(const skill of installerSkills)
  if(!/^[a-zA-Z0-9_-]+$/.test(skill.name))throw Error('Invalid review skill name');
 prepareInstaller();
 installed.push(...installerSkills.map(skill=>skill.name));
}
process.stdout.write(JSON.stringify({installed,verified:true}));
`;
