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
function directoryIdentity(dir){
 const st=fs.lstatSync(dir,{bigint:true});
 if(!st.isDirectory()||st.isSymbolicLink()||fs.realpathSync(dir)!==dir)throw Error('Review skill destination is not an owned directory');
 return [String(st.dev),String(st.ino),String(st.birthtimeNs)];
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
function verifyAlias(file,target){
 const st=exists(file);
 if(!st?.isSymbolicLink()||fs.readlinkSync(file)!==target)throw Error('Review skill publication destination already exists: '+file);
}
function retireAlias(owner,relative){
 retireOwnedPath(path.join(checkout,relative),staged=>verifyAlias(staged,path.join(owner.stage,relative)));
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
const installerSkills=input.skills.filter(skill=>skill.install);
const installers=installerSkills.map(skill=>skill.install);
const destinations=installers.flatMap(installCheck);
const marker=installers.length&&path.join(path.dirname(checkout),'.installed-review-skill-'+installers[0].installedName+'.json');
function readOwner(){
 const state=marker&&exists(marker);
 if(!state)return undefined;
 if(!state.isFile())throw Error('Invalid review skill ownership record');
 const owner=JSON.parse(fs.readFileSync(marker,'utf8'));
 if(!sameIdentity(owner.installers,installers)||path.dirname(owner.stage)!==checkout||!path.basename(owner.stage).startsWith('.farmslot-review-skills-'))
  throw Error('Invalid review skill ownership record');
 const relative=destinations.map(dir=>path.relative(checkout,dir));
 const allowed=new Set(relative.flatMap(dir=>[dir,path.dirname(dir),path.dirname(path.dirname(dir))]));
 if(!Array.isArray(owner.aliases)||!owner.aliases.every(alias=>allowed.has(alias))||
    !sameIdentity(Object.keys(owner.directories??{}).sort(),[...new Set(relative)].sort()))
  throw Error('Invalid review skill ownership paths');
 return owner;
}
function publishAliases(owner,published,resume){
 for(const relative of owner.aliases){
  const alias=path.join(checkout,relative),target=path.join(owner.stage,relative);
  directoryIdentity(path.dirname(alias));
  if(resume&&exists(alias))verifyAlias(alias,target);
  else{
   fs.symlinkSync(target,alias,'dir'); // exclusive, including when a destination appears after the check
   published.push(relative);
  }
 }
}
function prepareInstaller(){
 const prior=readOwner();
 if(prior){
  verifyTree(prior);
  for(const relative of prior.aliases)if(exists(path.join(checkout,relative)))
   verifyAlias(path.join(checkout,relative),path.join(prior.stage,relative));
  verifyUntracked(prior.aliases.map(relative=>path.join(checkout,relative)));
  if(input.verifyOnly){
   for(const relative of prior.aliases)verifyAlias(path.join(checkout,relative),path.join(prior.stage,relative));
  }else{
   const published=[];
   try{publishAliases(prior,published,true);}
   catch(error){
    for(const relative of published.reverse())retireAlias(prior,relative);
    throw error;
   }
  }
  return prior;
 }
 if(input.verifyOnly)throw Error('Review skill installation missing its ownership record');
 const aliases=[...new Set(destinations.map(publicationPath))];
 verifyUntracked(aliases.map(relative=>path.join(checkout,relative)));
 ignoreCheckoutPaths(['/.farmslot-review-skills-*/']);
 const stage=fs.mkdtempSync(path.join(checkout,'.farmslot-review-skills-'));
 const owner={installers,stage,identity:directoryIdentity(stage),aliases,directories:{}};
 const published=[];
 let claimed=false;
 try{
  for(const dest of destinations){
   const relative=path.relative(checkout,dest),privateDir=path.join(stage,relative);
   fs.mkdirSync(privateDir,{recursive:true});
   owner.directories[relative]=directoryIdentity(privateDir);
  }
  const pending=path.join(stage,'.receipt.json');
  fs.writeFileSync(pending,JSON.stringify(owner),{flag:'wx',mode:0o600});
  fs.linkSync(pending,marker);
  claimed=true;
  fs.unlinkSync(pending);
  publishAliases(owner,published,false);
  return owner;
 }catch(error){
  try{
   for(const relative of published.reverse())retireAlias(owner,relative);
   retireSkill(owner);
   if(claimed)fs.unlinkSync(marker);
  }catch(problem){throw Error(error.message+'; install rollback: '+problem.message);}
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
  verifyUntracked(owner.aliases.map(relative=>path.join(checkout,relative)));
  for(const relative of owner.aliases)retireAlias(owner,relative);
  retireSkill(owner);
  fs.unlinkSync(marker);
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
  ignoreCheckoutPaths(['/temp/tasks']);
 }
 const st=exists(tasks);
 if(st){if(!st.isSymbolicLink()||fs.readlinkSync(tasks)!==TASK_LINK)throw Error('Conflicting review task folder: '+tasks);}
 else{if(input.verifyOnly)throw Error('Review task folder link missing');fs.symlinkSync(TASK_LINK,tasks);}
}
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
 const owner=prepareInstaller();
 for(const skill of installerSkills){
  if(!/^[a-zA-Z0-9_-]+$/.test(skill.name))throw Error('Invalid review skill name');
  const [agents]=installCheck(skill.install);
  if(!input.verifyOnly){
   for(const relative of Object.keys(owner.directories)){
    const rejectLinks=dir=>{
     for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      if(entry.isSymbolicLink())throw Error('Review skill destination contains a symbolic link');
      if(entry.isDirectory())rejectLinks(path.join(dir,entry.name));
     }
    };
    rejectLinks(path.join(owner.stage,relative));
   }
   const run=cp.spawnSync('bash',[path.join(skill.install.source,'tools','install'),'--repo',skill.install.repo,'--target',checkout,'--source',skill.install.source,'--include',skill.install.include],{encoding:'utf8'});
   if(run.status!==0)throw Error('tools/install failed: '+String(run.stderr||run.stdout).slice(-2000));
   verifyTree(owner);
   for(const relative of owner.aliases)verifyAlias(path.join(checkout,relative),path.join(owner.stage,relative));
  }
  for(const file of [path.join(agents,'SKILL.md'),path.join(agents,'scripts','review-task.mjs')])
   if(!exists(file)||!within(owner.stage,fs.realpathSync(file)))throw Error('Review skill installation missing: '+path.relative(checkout,file));
  installed.push(skill.name);
 }
}
process.stdout.write(JSON.stringify({installed,verified:true}));
`;
