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
function verifyInstallDestinations(destinations){
 function rejectLinks(dir){
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
   if(entry.isSymbolicLink())throw Error('Review skill destination contains a symbolic link');
   if(entry.isDirectory())rejectLinks(path.join(dir,entry.name));
  }
 }
 for(const dir of destinations){
  const parent=path.dirname(dir);
  if(exists(parent)&&(fs.realpathSync(parent)!==parent||!fs.statSync(parent).isDirectory()))throw Error('Review skill destination parent is not an owned directory');
  const st=exists(dir);
  if(st){
   if(!st.isDirectory()||fs.realpathSync(dir)!==dir)throw Error('Review skill destination is not an owned directory');
   rejectLinks(dir);
  }
  const surface=path.dirname(parent);
  if(exists(surface)&&(fs.realpathSync(surface)!==surface||!fs.statSync(surface).isDirectory()))throw Error('Review skill destination parent is not an owned directory');
 }
 const tracked=require('node:child_process').spawnSync('git',['-C',checkout,'ls-files','-z','--',...destinations.map(dir=>path.relative(checkout,dir))],{encoding:'utf8'});
 if(tracked.status!==0||tracked.stdout)throw Error('Review skill installation would overwrite tracked files');
}
function directoryIdentity(dir){
 const st=fs.lstatSync(dir,{bigint:true});
 if(!st.isDirectory()||st.isSymbolicLink()||fs.realpathSync(dir)!==dir)throw Error('Review skill destination is not an owned directory');
 return [String(st.dev),String(st.ino),String(st.birthtimeNs)];
}
function retireOwnedDirectory(dir,expected,recursive){
 if(!exists(dir))return;
 // Moving within the workspace makes the verification and deletion apply to the same directory.
 const staging=fs.mkdtempSync(path.join(path.dirname(checkout),'.review-skill-retire-'));
 const staged=path.join(staging,'directory');
 try{fs.renameSync(dir,staged);}
 catch(error){fs.rmdirSync(staging);throw error;}
 const st=fs.lstatSync(staged);
 if(!st.isDirectory()||JSON.stringify(directoryIdentity(staged))!==JSON.stringify(expected))
  throw Error('Review skill destination identity changed; preserved at '+staged);
 if(recursive)fs.rmSync(staged,{recursive:true});
 else fs.rmdirSync(staged);
 fs.rmdirSync(staging);
}
function installedOwner(install,destinations,create,cleanup=false){
 const marker=path.join(path.dirname(checkout),'.installed-review-skill-'+install.installedName+'.json');
 const state=exists(marker);
 if(state){
  if(!state.isFile()||state.isSymbolicLink())throw Error('Invalid review skill ownership record');
  const owner=JSON.parse(fs.readFileSync(marker,'utf8'));
  if(JSON.stringify(owner.install)!==JSON.stringify(install))throw Error('Review skill installation belongs to a different source');
  if(owner.cursorRules&&owner.cursorRules!==path.join(checkout,'.cursor','rules'))throw Error('Invalid owned Cursor rules directory');
  const paths=[...destinations,...(owner.cursorRules?[owner.cursorRules]:[])];
  for(const dir of paths){
   if(cleanup&&!exists(dir))continue;
   if(JSON.stringify(directoryIdentity(dir))!==JSON.stringify(owner.directories[dir]))
    throw Error('Review skill destination identity changed');
  }
  return {marker,cursorRules:owner.cursorRules,directories:owner.directories};
 }
 if(!create)return undefined;
 if(destinations.some(dir=>exists(dir)))throw Error('Review skill destination already exists without an owner');
 const created=new Map();
 const reserve=dir=>{
  if(exists(dir)){directoryIdentity(dir);return;}
  reserve(path.dirname(dir));
  fs.mkdirSync(dir);
  created.set(dir,directoryIdentity(dir));
 };
 const staging=fs.mkdtempSync(path.join(path.dirname(checkout),'.review-skill-claim-'));
 try{
  for(const dir of destinations){
   reserve(path.dirname(dir));
   fs.mkdirSync(dir);
   created.set(dir,directoryIdentity(dir));
  }
  const rules=path.join(checkout,'.cursor','rules');
  const cursorRules=created.has(rules)?rules:undefined;
  const paths=[...destinations,...(cursorRules?[cursorRules]:[])];
  const directories=Object.fromEntries(paths.map(dir=>[dir,created.get(dir)]));
  const pending=path.join(staging,'receipt.json');
  fs.writeFileSync(pending,JSON.stringify({install,cursorRules,directories}),{flag:'wx',mode:0o600});
  fs.linkSync(pending,marker);
  return {marker,cursorRules,directories};
 }catch(error){
  const failures=[];
  for(const [dir,binding] of [...created].reverse()){
   try{retireOwnedDirectory(dir,binding,false);}
   catch(problem){failures.push(problem.message);}
  }
  if(failures.length)throw Error(error.message+'; install rollback: '+failures.join(', '));
  throw error;
 }finally{
  fs.rmSync(staging,{recursive:true});
 }
}
if(input.action==='cleanup'){
 // A failed retirement preserves the unexpected directory for operator recovery.
 if(fs.readdirSync(path.dirname(checkout)).some(name=>name.startsWith('.review-skill-retire-')))
  throw Error('Review skill cleanup has a preserved directory awaiting recovery');
 const links=[],directories=[];
 for(const skill of input.skills.filter(skill=>skill.install)){
  const destinations=installCheck(skill.install);
  const owner=installedOwner(skill.install,destinations,false,true);
  if(!owner)continue;
  verifyInstallDestinations(destinations);
  for(const dir of destinations)retireOwnedDirectory(dir,owner.directories[dir],true);
  if(owner.cursorRules&&exists(owner.cursorRules)&&fs.readdirSync(owner.cursorRules).length===0)
   retireOwnedDirectory(owner.cursorRules,owner.directories[owner.cursorRules],false);
  fs.unlinkSync(owner.marker);
 }
 if(input.skills.some(skill=>skill.install)){
  // The round folders stay in the workspace's review-tasks; only the checkout's link goes.
  const temp=path.join(checkout,'temp'),tasks=path.join(temp,'tasks');
  if(exists(temp)&&fs.realpathSync(temp)===temp){
   const taskLink=exists(tasks);
   if(taskLink&&taskLink.isSymbolicLink()&&fs.readlinkSync(tasks)===TASK_LINK){
    fs.unlinkSync(tasks);
    if(fs.readdirSync(temp).length===0)fs.rmdirSync(temp);
   }
  }
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
if(input.reviewTasks){
 const tasks=path.join(checkout,'temp','tasks');
 if(input.reviewTasks!==path.join(path.dirname(input.checkout),'review-tasks'))throw Error('Invalid review task root');
 if(!input.verifyOnly){
  fs.mkdirSync(path.resolve(path.dirname(tasks),TASK_LINK),{recursive:true});
  directory(path.dirname(tasks));
  const exclude=require('node:child_process').spawnSync('git',['-C',checkout,'rev-parse','--path-format=absolute','--git-path','info/exclude'],{encoding:'utf8'});
  if(exclude.status!==0)throw Error('Review checkout has no Git exclude file');
  const file=exclude.stdout.trim(),text=exists(file)?fs.readFileSync(file,'utf8'):'';
  if(!text.split('\n').includes('/temp/tasks')){fs.mkdirSync(path.dirname(file),{recursive:true});fs.appendFileSync(file,(text&&!text.endsWith('\n')?'\n':'')+'/temp/tasks\n');}
 }
 const st=exists(tasks);
 if(st){if(!st.isSymbolicLink()||fs.readlinkSync(tasks)!==TASK_LINK)throw Error('Conflicting review task folder: '+tasks);}
 else{if(input.verifyOnly)throw Error('Review task folder link missing');fs.symlinkSync(TASK_LINK,tasks);}
}
const installed=[];
for(const skill of input.skills){
 if(!/^[a-zA-Z0-9_-]+$/.test(skill.name))throw Error('Invalid review skill name');
 if(skill.install){
  const destinations=installCheck(skill.install),[agents]=destinations;
  if(!input.verifyOnly){
   verifyInstallDestinations(destinations);
   installedOwner(skill.install,destinations,true);
   const run=require('node:child_process').spawnSync('bash',[path.join(skill.install.source,'tools','install'),'--repo',skill.install.repo,'--target',checkout,'--source',skill.install.source,'--include',skill.install.include],{encoding:'utf8'});
   if(run.status!==0)throw Error('tools/install failed: '+String(run.stderr||run.stdout).slice(-2000));
   installedOwner(skill.install,destinations,false);
  }
  else if(!installedOwner(skill.install,destinations,false))throw Error('Review skill installation missing its ownership record');
  for(const file of [path.join(agents,'SKILL.md'),path.join(agents,'scripts','review-task.mjs')])
   if(!exists(file)||!within(checkout,fs.realpathSync(file)))throw Error('Review skill installation missing: '+path.relative(checkout,file));
  installed.push(skill.name);
  continue;
 }
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
process.stdout.write(JSON.stringify({installed,verified:true}));
`;
