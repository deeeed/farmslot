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
if(input.action==='cleanup'){
 const links=[],directories=[];
 for(const skill of input.skills){
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
const installed=[];
for(const skill of input.skills){
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
process.stdout.write(JSON.stringify({installed,verified:true}));
`;
