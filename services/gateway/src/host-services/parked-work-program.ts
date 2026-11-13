// Runs as one owned slot command, never in the gateway request loop.
export const PARKED_WORK_PROGRAM = String.raw`
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const input = JSON.parse(process.argv[1]);
const repo = input.repo.startsWith('~/') ? path.join(os.homedir(), input.repo.slice(2)) : input.repo;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-park-'));
const env = { ...process.env };
for (const key of ['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES','GIT_COMMON_DIR','GIT_NAMESPACE','GIT_PREFIX']) delete env[key];
env.GIT_OPTIONAL_LOCKS = '0';
const config = ['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','commit.gpgSign=false','-c','gc.auto=0','-c','maintenance.auto=false','-c','submodule.recurse=false','-C',repo];
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function git(args, options = {}) {
  const result = cp.spawnSync('git', config.concat(args), { timeout: options.timeout, env: options.index ? { ...env, GIT_INDEX_FILE: options.index } : env, input: options.input, encoding: null, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0 && !(options.allow || []).includes(result.status)) fail('GIT_FAILED', 'Git ' + args[0] + ' failed with exit ' + result.status + ': ' + (result.stderr || '').toString().slice(-500));
  return { status: result.status, stdout: result.stdout || Buffer.alloc(0) };
}
const text = (args, options) => git(args, options).stdout.toString('utf8').trim();
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const safe = value => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/.test(value) && !value.includes('..') && !value.endsWith('.lock') ? value : 'key-' + hash(value).slice(0,32);
const slotKey = safe(input.slotId);
const root = 'refs/farmslot/parked/';
const prefix = root + slotKey + '/';
const metadataRef = ref => ref.replace(root, 'refs/farmslot/parked-meta/');
function exists(file) { try { return fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null; throw e; } }
function nul(buffer) { return buffer.toString('utf8').split('\0').filter(Boolean); }
function refSha(ref) { const r = git(['rev-parse','--verify','--quiet',ref], { allow:[1,128] }); return r.status === 0 ? r.stdout.toString('utf8').trim() : null; }
function repositoryKey() {
  let common = text(['rev-parse','--git-common-dir']);
  const runId = text(['config','--local','--get','farmslot.blindRun'], {allow:[1]});
  if (runId) {
    // Blind receipts will live in the original repository after Git restoration.
    const worktree = text(['config','--local','--get','core.worktree']);
    const capsules = path.join(path.dirname(worktree), '.farmslot-blind-evals', input.slotId);
    const states = fs.readdirSync(capsules).filter(name => name.startsWith(runId+'-')).map(name =>
      JSON.parse(fs.readFileSync(path.join(capsules,name,'state.json'),'utf8'))
    ).filter(state => state.runId === runId && state.slotId === input.slotId &&
      path.resolve(state.repo) === path.resolve(repo) && state.phase === 'isolated');
    if (states.length !== 1) fail('INVALID_METADATA','Cannot identify the original blind repository');
    const state = states[0];
    if (!state.originalIsDirectory) common =
      text(['--git-dir='+state.originalDirectory,'rev-parse','--git-common-dir']);
  }
  return hash(path.resolve(repo, common));
}
function branch() { return text(['symbolic-ref','--quiet','--short','HEAD'], {allow:[1]}) || 'HEAD'; }
function stageEntries(buffer) {
  return nul(buffer).map(line => { const tab = line.indexOf('\t'); const fields = line.slice(0,tab).split(' '); return { mode:fields[0], sha:fields[1], stage:Number(fields[2]), file:line.slice(tab+1) }; });
}
function treeFromEntries(entries, name) {
  const index = path.join(temporary, name);
  git(['read-tree','--empty'], {index});
  if (entries.length) git(['update-index','-z','--index-info'], {index,input:Buffer.from(entries.map(e => e.mode+' '+e.sha+'\t'+e.file+'\0').join(''))});
  return text(['write-tree','--missing-ok'], {index});
}
function makeTree(entries) { return text(['mktree','-z','--missing'], {input:Buffer.from(entries.map(e => e.mode+' '+e.type+' '+e.sha+'\t'+e.file+'\0').join(''))}); }
function commit(tree, parents, message) {
  return text(['-c','user.name=Farmslot','-c','user.email=parked-work@farmslot.invalid','commit-tree',tree].concat(parents.flatMap(p => ['-p',p])), {input:Buffer.from(message+'\n')});
}
function readObjects(names) {
  if(!names.length)return [];
  const output=git(['cat-file','--batch'],{input:Buffer.from(names.join('\n')+'\n')}).stdout;
  let offset=0;
  return names.map(() => {
    const end=output.indexOf(10,offset); if(end<0)fail('INVALID_METADATA','Incomplete Git object response');
    const header=output.subarray(offset,end).toString('utf8').split(' '); offset=end+1;
    if(header[1]==='missing')return null;
    const size=Number(header[2]);
    if(!Number.isSafeInteger(size)||size<0||offset+size>=output.length)fail('INVALID_METADATA','Invalid Git object size');
    const object={type:header[1],body:output.subarray(offset,offset+size)}; offset+=size+1; return object;
  });
}
function exposedIgnoredPaths(targets) {
  const ignored=nul(git(['ls-files','--others','--ignored','--exclude-standard','--directory','-z']).stdout);
  if(!ignored.length)return [];
  const gitdir=text(['rev-parse','--absolute-git-dir']), exposed=new Set();
  for(const target of new Set(targets)) {
    const directory=fs.mkdtempSync(path.join(temporary,'ignore-rules-'));
    const entries=nul(git(['ls-tree','-r','-z',target]).stdout).flatMap(line => {
      const tab=line.indexOf('\t'), file=line.slice(tab+1), fields=line.slice(0,tab).split(' ');
      return path.posix.basename(file)==='.gitignore' && ['100644','100755'].includes(fields[0]) ? [{file,sha:fields[2]}] : [];
    });
    const blobs=readObjects(entries.map(e=>e.sha));
    for(const [i,entry] of entries.entries()) {
      if(!blobs[i]||blobs[i].type!=='blob')fail('INVALID_METADATA','Target ignore rules are unreadable');
      const file=path.join(directory,entry.file); fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,blobs[i].body);
    }
    // Git evaluates its own rules, including the existing global and info exclusions.
    const kept=new Set(nul(git(['--git-dir='+gitdir,'--work-tree='+directory,'-C',directory,'check-ignore','--no-index','-z','--stdin'],{input:Buffer.from(ignored.join('\0')+'\0'),allow:[1]}).stdout));
    for(const file of ignored)if(!kept.has(file))exposed.add(file);
  }
  return [...exposed];
}
function snapshot(full) {
  const head = text(['rev-parse','HEAD']);
  const currentBranch = branch();
  const indexPath = text(['rev-parse','--git-path','index']);
  const normalized = path.join(temporary,'original-index');
  fs.copyFileSync(path.resolve(repo,indexPath),normalized);
  git(['update-index','--no-split-index'], {index:normalized});
  const stages = git(['ls-files','--stage','-z'], {index:normalized}).stdout;
  const flags = git(['ls-files','-v','-z'], {index:normalized}).stdout;
  const entries = stageEntries(stages);
  const working = path.join(temporary,'working-index');
  // A copied index can trust same-size/same-mtime entries and miss a real edit.
  // Rebuild the temporary index with zero stat-cache entries; never touch the real index.
  git(['read-tree','--empty'], {index:working});
  if(entries.length) git(['update-index','-z','--index-info'], {index:working,input:stages});
  git(['add','--all','--','.'], {index:working});
  // Save ignored collisions and files that a reset's ignore rules would expose to clean.
  const extra=[];
  for(const ref of input.extraRefs||[]) { const sha=refSha(ref); if(sha)extra.push([ref,sha]); }
  const targets=[...new Set(text(['rev-parse',...[head,...(input.targetTrees||[]),...extra.map(pair=>pair[1])].map(ref=>ref+'^{tree}')]).split('\n'))];
  const collisionPaths = new Set(exposedIgnoredPaths(targets));
  for (const target of targets) {
    for (const file of nul(git(['ls-tree','-r','-z','--name-only',target]).stdout)) if (exists(path.join(repo,file))) collisionPaths.add(file);
  }
  if (collisionPaths.size) git(['--literal-pathspecs','add','--force','--pathspec-from-file=-','--pathspec-file-nul'], {index:working,input:Buffer.from([...collisionPaths].join('\0')+'\0')});
  const savedEntries = stageEntries(git(['ls-files','--stage','-z'], {index:working}).stdout);
  const originalLinks = new Set(entries.filter(e => e.mode === '160000').map(e => e.file));
  if (savedEntries.some(e => e.mode === '160000' && !originalLinks.has(e.file))) fail('NESTED_WORKSPACE','Retain the nested checkout through the existing workspace collector before retrying');
  const worktreeTreeSha = text(['write-tree'], {index:working});
  const fingerprint = hash(JSON.stringify({head,branch:currentBranch,stages:hash(stages),flags:hash(flags),tree:worktreeTreeSha,extra,targets}));
  const staged = git(['diff','--cached','--quiet','HEAD','--'], {index:normalized,allow:[1]}).status !== 0;
  const specialFlags = nul(flags).some(line => line[0] === 'S' || line[0] !== line[0].toUpperCase());
  const dirty = staged || specialFlags || worktreeTreeSha !== text(['rev-parse','HEAD^{tree}']);
  const result = {head,branch:currentBranch,worktreeTreeSha,fingerprint,dirty,extra,repoKey:repositoryKey(),namespace:prefix};
  if (full && dirty) {
    const raw = text(['hash-object','-w','--stdin'], {input:fs.readFileSync(normalized)});
    const roots = [{mode:'100644',type:'blob',sha:raw,file:'index'}];
    for (let stage=0;stage<4;stage++) roots.push({mode:'040000',type:'tree',sha:treeFromEntries(entries.filter(e=>e.stage===stage),'stage-'+stage),file:'stage'+stage});
    result.indexArchiveSha = commit(makeTree(roots),[head],'Parked index state');
  }
  return result;
}
function inventory() {
  const lines = text(['for-each-ref','--format=%(refname)%00%(objectname)',root]);
  const rows = lines ? lines.split('\n').map(line => { const p=line.split('\0'); return {ref:p[0],headSha:p[1]}; }) : [];
  const selected = rows.filter(r => r.ref.startsWith(prefix) || r.ref.slice(root.length).split('/').length === 2);
  if (!selected.length) return {repoKey:repositoryKey(),namespace:prefix,items:[]};
  const objects=readObjects(selected.map(row=>metadataRef(row.ref)));
  for(const [i,row] of selected.entries()) {
    const object=objects[i];
    if(!object){row.metadata=null;continue;}
    if(object.type!=='blob'||object.body.length>2*1024*1024)fail('INVALID_METADATA','Invalid parked receipt object');
    row.metadata=object.body.toString('utf8');
  }
  return {repoKey:repositoryKey(),namespace:prefix,items:selected};
}
function park() {
  if(input.checks && input.checks.branch && branch() !== input.checks.branch) return {receipts:[],fingerprint:null,repoKey:repositoryKey(),namespace:prefix};
  const currentHead=text(['rev-parse','HEAD']);
  if(!input.sourceHeads && input.checks && input.checks.headSha && currentHead !== input.checks.headSha) return {receipts:[],fingerprint:null,repoKey:repositoryKey(),namespace:prefix};
  if(!input.sourceHeads && input.checks && input.checks.baseSha && git(['merge-base','--is-ancestor',input.checks.baseSha,currentHead], {allow:[1,128]}).status !== 0) return {receipts:[],fingerprint:null,repoKey:repositoryKey(),namespace:prefix};
  const state=input.includeWorktree === false ? null : snapshot(true);
  if(state && input.checks) {
    if((input.checks.branch && state.branch!==input.checks.branch) || (input.checks.headSha && state.head!==input.checks.headSha) || (input.checks.baseSha && state.head!==currentHead && git(['merge-base','--is-ancestor',input.checks.baseSha,state.head],{allow:[1,128]}).status!==0))return {receipts:[],fingerprint:null,repoKey:repositoryKey(),namespace:prefix};
  }
  const heads = input.sourceHeads ? input.sourceHeads.slice() : [{branch:state ? state.branch : branch(),headSha:state ? state.head : currentHead,current:true}];
  if(state) for(const pair of state.extra) heads.push({branch:pair[0].replace('refs/heads/',''),headSha:pair[1]});
  const repoKey=repositoryKey(), receipts=[], creates=[], seen=new Set();
  for(let item of heads) {
    const resolved=refSha(item.headSha+'^{commit}');
    if(!resolved)continue;
    item={...item,headSha:resolved};
    if(input.sourceHeads && input.checks && input.checks.headSha && item.headSha!==input.checks.headSha)continue;
    if(input.sourceHeads && input.checks && input.checks.baseSha && git(['merge-base','--is-ancestor',input.checks.baseSha,item.headSha],{allow:[1,128]}).status!==0)continue;
    const dirty=!!(state && item.current && state.dirty);
    const fingerprint=dirty ? hash(JSON.stringify([item.headSha,item.branch,state.worktreeTreeSha,state.fingerprint])) : hash(JSON.stringify([item.headSha,item.branch]));
    const key=hash(JSON.stringify([input.purpose,item.branch,item.headSha,fingerprint,dirty]));
    const ref=prefix+safe(input.operationKey)+'/'+key;
    if(seen.has(ref))continue; seen.add(ref);
    const meta=metadataRef(ref), existing=refSha(ref), existingMeta=refSha(meta);
    if(existing && existingMeta) {
      const metadata=git(['cat-file','blob',existingMeta]).stdout.toString('utf8'), saved=JSON.parse(metadata);
      if(saved.ref!==ref || saved.headSha!==existing || saved.sourceHeadSha!==item.headSha || saved.branch!==item.branch) fail('INVALID_METADATA','Parked snapshot identity changed');
      receipts.push({ref,headSha:existing,metadata}); continue;
    }
    if(existing || existingMeta) fail('PARTIAL_PARK','A parked snapshot has incomplete metadata; repair it before retrying');
    const headSha=dirty ? commit(state.worktreeTreeSha,[item.headSha,state.indexArchiveSha],'Parked working tree') : item.headSha;
    const baseSha=input.baseSha || refSha('refs/remotes/origin/'+input.defaultBranch) || item.headSha;
    const revisions=git(['rev-list',item.headSha,'--not'].concat(input.notRevs || [baseSha,'--remotes'])).stdout.toString('utf8').trim();
    if(input.onlyThreatened && !dirty && !revisions) continue;
    const record={storageVersion:1,slotId:input.slotId,ref,metadataRef:meta,branch:item.branch,baseSha,headSha,sourceHeadSha:item.headSha,commits:revisions?revisions.split('\n'):[],parkedAt:input.at,kind:dirty?'worktree':'commits',purpose:input.purpose,operationKey:input.operationKey,repoKey,fingerprint:state ? state.fingerprint : fingerprint};
    if(dirty) { record.indexArchiveSha=state.indexArchiveSha; record.worktreeTreeSha=state.worktreeTreeSha; }
    if(input.runId) record.runId=input.runId;
    const json=JSON.stringify(record), blob=text(['hash-object','-w','--stdin'], {input:Buffer.from(json)});
    creates.push('create '+ref+' '+headSha, 'create '+meta+' '+blob);
    receipts.push({ref,headSha,metadata:json});
  }
  if(creates.length) git(['update-ref','--stdin'], {input:Buffer.from('start\n'+creates.join('\n')+'\nprepare\ncommit\n')});
  return {receipts,fingerprint:state?state.fingerprint:null,repoKey,namespace:prefix};
}
function verify() {
  const state=snapshot(false);
  if(state.fingerprint !== input.expectedFingerprint) fail('WORK_CHANGED','Local work changed after parking; capture it again');
  for(const saved of input.saved || []) {
    if(refSha(saved.ref) !== saved.headSha || !refSha(metadataRef(saved.ref))) fail('SNAPSHOT_MISSING','A required parked snapshot is missing');
  }
  return state;
}
function mutate() {
  verify();
  const commandEnv={...env,GIT_CONFIG_PARAMETERS:(env.GIT_CONFIG_PARAMETERS?env.GIT_CONFIG_PARAMETERS+' ':'')+"'core.hooksPath=/dev/null' 'submodule.recurse=false'"};
  const r=cp.spawnSync('bash',['-c',input.command],{cwd:repo,env:commandEnv,encoding:'utf8',maxBuffer:64*1024*1024});
  return {stdout:r.stdout||'',stderr:r.stderr||'',exitCode:r.status === null?1:r.status};
}
function restore() {
  verify();
  const saved=input.receipt;
  if(refSha(saved.ref) !== saved.headSha) fail('SNAPSHOT_MISSING','The selected parked snapshot is missing');
  const original=saved.sourceHeadSha||saved.headSha;
  let name=input.restoreBranch || 'restored/parked-'+hash(saved.ref).slice(0,12);
  if(input.restoreBranch && refSha('refs/heads/'+name)) fail('BRANCH_EXISTS','The replay branch already exists');
  if(!input.restoreBranch && refSha('refs/heads/'+name)) name+='-'+crypto.randomBytes(4).toString('hex');
  git(['clean','-fd']);
  git(['reset','--hard','--no-recurse-submodules','HEAD']);
  git(['checkout','-b',name,original]);
  if(saved.kind === 'worktree') {
    const working=path.join(temporary,'restore-index');
    git(['read-tree',original],{index:working});
    git(['read-tree','--reset','-u',saved.worktreeTreeSha],{index:working});
    const indexFile=text(['rev-parse','--git-path','index']);
    const target=path.resolve(repo,indexFile), lock=target+'.lock';
    const fd=fs.openSync(lock,'wx',0o600);
    try { fs.writeFileSync(fd,git(['show',saved.indexArchiveSha+':index']).stdout); fs.closeSync(fd); fs.renameSync(lock,target); }
    catch(error) { try{fs.closeSync(fd);}catch(e){if(e.code!=='EBADF')throw e;} if(exists(lock))fs.unlinkSync(lock); throw error; }
  }
  return {branch:name,headSha:text(['rev-parse','HEAD']),fingerprint:snapshot(false).fingerprint};
}
function prune() {
  const protectedRefs=new Set(input.protectedRefs||[]), pruned=[];
  const before=Date.parse(input.before);
  let reachable=null;
  function remoteReachable() {
    if(reachable) return reachable;
    const advertised=new Set();
    for(const remote of text(['remote']).split('\n').filter(Boolean)) {
      const r=git(['ls-remote','--heads',remote],{allow:[1,2,128],timeout:10000});
      if(r.status===0) for(const line of r.stdout.toString('utf8').split('\n')) { const sha=line.split('\t')[0]; if(/^[a-f0-9]{40,64}$/.test(sha))advertised.add(sha); }
    }
    reachable=new Set(advertised);
    if(advertised.size) {
      const checked=git(['cat-file','--batch-check=%(objectname) %(objecttype)'],{input:Buffer.from([...advertised].join('\n')+'\n')}).stdout.toString('utf8');
      const local=checked.split('\n').filter(l=>l.endsWith(' commit')).map(l=>l.split(' ')[0]);
      if(local.length) for(const sha of text(['rev-list','--stdin'],{input:Buffer.from(local.join('\n')+'\n')}).split('\n')) if(sha)reachable.add(sha);
    }
    return reachable;
  }
  for(const record of input.receipts||[]) {
    if(protectedRefs.has(record.ref)||refSha(record.ref)!==record.headSha)continue;
    let reason=null;
    if(record.parkedAt && Number.isFinite(Date.parse(record.parkedAt)) && Date.parse(record.parkedAt)<before)reason='age';
    else if(record.kind!=='worktree' && remoteReachable().has(record.headSha))reason='remote';
    if(!reason)continue;
    const meta=metadataRef(record.ref), old=refSha(meta);
    const fact={...record,prunedAt:input.at,pruneReason:reason};
    const blob=text(['hash-object','-w','--stdin'],{input:Buffer.from(JSON.stringify(fact))});
    git(['update-ref','--stdin'],{input:Buffer.from('start\ndelete '+record.ref+' '+record.headSha+'\n'+(old?'update '+meta+' '+blob+' '+old:'create '+meta+' '+blob)+'\nprepare\ncommit\n')});
    pruned.push(fact);
  }
  return {pruned};
}
try {
  let value;
  if(input.op==='park')value=park();
  else if(input.op==='list')value=inventory();
  else if(input.op==='lookup') { const sha=refSha(input.ref); const meta=refSha(metadataRef(input.ref)); value={headSha:sha,metadata:meta?git(['cat-file','blob',meta]).stdout.toString('utf8'):null}; }
  else if(input.op==='mutate')value=mutate();
  else if(input.op==='restore')value=restore();
  else if(input.op==='prune')value=prune();
  else fail('INVALID_OPERATION','Unknown parked-work operation');
  process.stdout.write(JSON.stringify({ok:true,value})+'\n');
} catch(error) {
  process.stdout.write(JSON.stringify({ok:false,code:error.code||'PARK_FAILED',message:error.code?error.message:'Parked-work operation failed'})+'\n');
  process.exitCode=error.code==='WORK_CHANGED'?42:1;
} finally { fs.rmSync(temporary,{recursive:true,force:true}); }
`;
