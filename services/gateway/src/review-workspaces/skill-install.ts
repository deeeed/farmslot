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
function verifyAlias(file,owner,alias){
 if(!sameIdentity(aliasIdentity(file,path.join(owner.stage,alias.relative)),alias.identity))
  throw Error('Review skill publication link identity changed');
}
function retireAlias(owner,alias){
 retireOwnedPath(path.join(checkout,alias.relative),staged=>verifyAlias(staged,owner,alias));
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
 if(!sameIdentity(owner.installers,installers)||path.dirname(owner.stage)!==path.dirname(checkout)||!path.basename(owner.stage).startsWith('.review-skills-'))
  throw Error('Invalid review skill ownership record');
 const relative=destinations.map(dir=>path.relative(checkout,dir));
 const allowed=new Set(relative.flatMap(dir=>[dir,path.dirname(dir),path.dirname(path.dirname(dir))]));
 if(!Array.isArray(owner.aliases)||!owner.aliases.every(alias=>allowed.has(alias.relative))||
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
  for(const alias of prior.aliases)verifyAlias(path.join(checkout,alias.relative),prior,alias);
  return;
 }
 if(input.verifyOnly)throw Error('Review skill installation missing its ownership record');
 const aliases=[...new Set(destinations.map(publicationPath))];
 verifyUntracked(aliases.map(relative=>path.join(checkout,relative)));
 const stage=fs.mkdtempSync(path.join(path.dirname(checkout),'.review-skills-'));
 const owner={installers,stage,identity:statIdentity(fs.lstatSync(stage,{bigint:true})),aliases:[],directories:{}};
 let publishing;
 try{
  // Install into the private tree with the explicit client. No checkout link or receipt exists yet.
  verifyTree(owner);
  for(const install of installers){
   const result=cp.spawnSync('bash',[path.join(install.source,'tools','install'),'--repo',install.repo,'--target',stage,'--source',install.source,'--include',install.include],{encoding:'utf8'});
   if(result.status!==0)throw Error('tools/install failed: '+String(result.stderr||result.stdout||result.error).slice(-2000));
  }
  verifyInstalled(stage);
  for(const dest of destinations){
   const relative=path.relative(checkout,dest);
   owner.directories[relative]=directoryIdentity(path.join(stage,relative));
  }
  verifyTree(owner);
  for(const relative of aliases){
   const alias=path.join(checkout,relative),target=path.join(stage,relative);
   directoryIdentity(path.dirname(alias));
   fs.symlinkSync(target,alias,'dir'); // never replaces a destination, even after preflight
   publishing=alias;
   owner.aliases.push({relative,identity:aliasIdentity(alias,target)});
   publishing=undefined;
  }
  const pending=path.join(stage,'.receipt.json');
  fs.writeFileSync(pending,JSON.stringify(owner),{flag:'wx',mode:0o600});
  fs.linkSync(pending,marker);
 }catch(error){
  try{
   for(const alias of [...owner.aliases].reverse())retireAlias(owner,alias);
   if(publishing)throw Error('Link identity unavailable; staging preserved at '+stage);
   retireSkill(owner);
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
  verifyUntracked(owner.aliases.map(alias=>path.join(checkout,alias.relative)));
  for(const alias of owner.aliases)retireAlias(owner,alias);
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
if(input.reviewTasks&&input.reviewTasks!==path.join(path.dirname(input.checkout),'review-tasks'))throw Error('Invalid review task root');
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
if(input.reviewTasks){
 const tasks=path.join(checkout,'temp','tasks');
 if(!input.verifyOnly){
  fs.mkdirSync(path.resolve(path.dirname(tasks),TASK_LINK),{recursive:true});
  directory(path.dirname(tasks));
  ignoreCheckoutPaths(['/temp/tasks']);
 }
 const st=exists(tasks);
 if(st){if(!st.isSymbolicLink()||fs.readlinkSync(tasks)!==TASK_LINK)throw Error('Conflicting review task folder: '+tasks);}
 else{if(input.verifyOnly)throw Error('Review task folder link missing');fs.symlinkSync(TASK_LINK,tasks);}
}
process.stdout.write(JSON.stringify({installed,verified:true}));
`;
