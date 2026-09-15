/** Shared OS identity checks for the allocator and its gated Git supervisor.
 * Uses the same ps start-identity/group approach as native/process-tree.ts.
 * Embedded because a remote exec node need not have gateway source installed.
 */
const PROCESS_SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync, spawn} = require('node:child_process');
function census() {
  const probe = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='], {encoding:'utf8', timeout:5000, maxBuffer:16*1024*1024, stdio:['ignore','pipe','pipe']});
  if (probe.error || probe.status !== 0) throw probe.error || new Error('Process census failed: ' + probe.stderr);
  const output = probe.stdout;
  const records = new Map();
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (match && Number(match[1]) !== probe.pid && !match[4].startsWith('Z')) records.set(Number(match[1]), {pid:Number(match[1]), parent:Number(match[2]), group:Number(match[3]), start:match[5].trim()});
  }
  return records;
}
function matches(actual, expected) { return actual && expected && actual.pid === expected.pid && actual.start === expected.start && actual.group === expected.group; }
function directory(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive:true, mode:0o700});
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Workspace directory is not owned: ' + dir);
}
function syncDirectory(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function write(file, value) {
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  syncDirectory(path.dirname(file));
}
function read(file) {
  if (!fs.existsSync(file)) return undefined;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid workspace identity file: ' + file);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function signal(owner, kind) {
  if (!matches(census().get(owner.pid), owner)) return;
  try { process.kill(owner.pid, kind); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function stopGroup(supervisor, gitIdentity) {
  let snapshot = census();
  const members = [...snapshot.values()].filter((record) => record.group === supervisor.pid);
  if (!members.length) return;
  if (!members.some((record) => matches(record, supervisor) || matches(record, gitIdentity)))
    throw new Error('Git process group ownership is unconfirmed');
  // A matching supervisor or gated Git identity proves this is the recorded group.
  // Stop that group before the final census, preventing further child creation.
  try { process.kill(-supervisor.pid, 'SIGSTOP'); }
  catch (error) { if (error.code === 'ESRCH' && ![...census().values()].some((record) => record.group === supervisor.pid)) return; throw error; }
  snapshot = census();
  if (![...snapshot.values()].some((record) => record.group === supervisor.pid && (matches(record, supervisor) || matches(record, gitIdentity))))
    throw new Error('Git process group identity changed before termination');
  process.kill(-supervisor.pid, 'SIGKILL');
  const deadline = Date.now() + 5000;
  while ([...census().values()].some((record) => record.group === supervisor.pid)) {
    if (Date.now() >= deadline) throw new Error('Owned Git processes did not stop');
    await delay(25);
  }
}
`;

const GIT_SUPERVISOR_SCRIPT =
  PROCESS_SCRIPT +
  String.raw`
const request = JSON.parse(process.argv[1]);
const supervisor = census().get(process.pid);
if (!supervisor || supervisor.group !== process.pid) throw new Error('Git supervisor has no isolated process group');
write(path.join(request.directory, 'supervisor.json'), supervisor);
let released = false;
process.on('disconnect', () => { if (!released) process.exit(1); });
process.on('message', async (message) => {
  if (released || message !== 'start') return;
  released = true;
  try {
    // The shell cannot execute Git until its identity is durable. EOF fails closed.
    const git = spawn('bash', ['-c', 'IFS= read -r gate || exit 75; exec "$@"', 'workspace-git', 'git', ...request.args], {
      env:request.environment, stdio:['pipe','inherit','inherit'],
    });
    const completion = new Promise((resolve, reject) => {git.once('error', reject); git.once('exit', (code, signal) => resolve({code,signal}));});
    if (!git.pid) throw new Error('Git gate did not obtain a PID');
    const gitIdentity = census().get(git.pid);
    if (!gitIdentity || gitIdentity.group !== supervisor.pid) throw new Error('Git gate escaped its supervisor group');
    write(path.join(request.directory, 'git.json'), gitIdentity);
    git.stdin.end('start\n');
    const timeout = setTimeout(() => { process.stderr.write('Git command exceeded its execution deadline'); process.exit(1); }, 240000);
    const result = await completion;
    clearTimeout(timeout);
    // Git may exit before helpers. The surviving supervisor anchors their group.
    const deadline = Date.now() + 5000;
    while (true) {
      const members = [...census().values()].filter((record) => record.group === supervisor.pid && record.pid !== process.pid);
      if (!members.length) break;
      for (const member of members) signal(member, 'SIGKILL');
      if (Date.now() >= deadline) throw new Error('Git helpers remain alive after command exit');
      await delay(25);
    }
    write(path.join(request.directory, 'result.json'), {...result, stopped:true});
    process.exit(result.code === 0 ? 0 : 1);
  } catch (error) {
    process.stderr.write(error.message);
    // Leave identity records intact. The operation owner/recovery stops this group.
    process.exit(1);
  }
});
process.send('ready');
`;

export const REVIEW_WORKSPACE_SCRIPT =
  PROCESS_SCRIPT +
  '\nconst GIT_SUPERVISOR_SCRIPT = ' +
  JSON.stringify(GIT_SUPERVISOR_SCRIPT) +
  ';\n' +
  String.raw`
const input = JSON.parse(process.argv[1]);
const root = path.resolve(input.root);
const identity = input.identity;
const workspace = path.join(root, 'runs', identity.workspaceId);
const checkout = path.join(workspace, 'source');
const cacheIdentity = {owner:identity.owner, project:identity.project, repositoryUrl:identity.repositoryUrl};
const cacheKey = crypto.createHash('sha256').update(JSON.stringify(cacheIdentity)).digest('hex');
const cache = path.join(root, 'repositories', cacheKey);
const lock = path.join(root, 'locks', cacheKey);
const operations = path.join(root, 'operations');
let operation;
let operationPath;
const environment = {...process.env, GIT_TERMINAL_PROMPT:'0', GIT_CONFIG_NOSYSTEM:'1', GIT_OPTIONAL_LOCKS:'0'};
for (const key of ['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_COMMON_DIR','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES','BASH_ENV','ENV']) delete environment[key];
function same(actual, expected) { return JSON.stringify(actual) === JSON.stringify(expected); }
function marker(file, expected, allowCreate) {
  const current = read(file);
  if (current && !same(current, expected)) throw new Error('Workspace identity conflict: ' + file);
  if (!current) {
    if (!allowCreate) throw new Error('Missing workspace ownership marker: ' + file);
    write(file, expected);
  }
}
const cancellationPath = path.join(workspace, 'cancel.json');
function assertWorkspaceOperationCurrent() {
  if (input.action !== 'allocate' && (input.action !== 'cleanup' || input.allowCancelled)) return;
  const cancelled = read(cancellationPath);
  if (cancelled) {
    if (!same(cancelled, identity)) throw new Error('Workspace cancellation identity conflict');
    throw new Error('Workspace operation was cancelled');
  }
}
function pending(previous) {
  return Object.assign(new Error('REVIEW_WORKSPACE_OPERATION_PENDING: ' + JSON.stringify(previous)), {code:'REVIEW_WORKSPACE_OPERATION_PENDING'});
}
function linkTarget(file) {
  const target = fs.readlinkSync(file);
  if (path.dirname(target) !== operations || !/^[a-f0-9-]{36}$/.test(path.basename(target))) throw new Error('Invalid allocator ownership link');
  return target;
}
function lockFiles() {
  const result = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, {withFileTypes:true})) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Unexpected symlink in managed Git metadata');
      if (entry.isDirectory()) { if (entry.name !== 'objects') walk(file); else { const pack = path.join(file,'pack'); if (fs.existsSync(pack)) walk(pack); } }
      else if (entry.name.endsWith('.lock')) result.push(path.relative(cache, file));
    }
  }
  if (fs.existsSync(cache)) directory(cache);
  walk(cache);
  return result;
}
function commandDirectories(ownerPath) {
  const commands = path.join(ownerPath, 'commands');
  return fs.existsSync(commands) ? fs.readdirSync(commands).map((name) => path.join(commands, name)) : [];
}
async function stopCommands(ownerPath) {
  for (const command of commandDirectories(ownerPath)) {
    const supervisor = read(path.join(command, 'supervisor.json'));
    if (supervisor) await stopGroup(supervisor, read(path.join(command, 'git.json')));
    // No supervisor receipt means no start grant could have been sent.
  }
}
function repairPartialWorktree(previous, ownerPath) {
  const previousWorkspace = path.join(root, 'runs', previous.identity.workspaceId);
  const previousCheckout = path.join(previousWorkspace, 'source');
  const receiptPath = path.join(previousWorkspace, 'allocation.json');
  const receipt = read(receiptPath);
  const commands = commandDirectories(ownerPath).map((command) => read(path.join(command, 'request.json')));
  const partial = receipt?.state === 'allocating' && commands.some((command) => command.phase === 'add-worktree');
  const removing = receipt?.state === 'cleaning';
  if (!partial && !removing) return;
  marker(path.join(previousWorkspace, 'identity.json'), previous.identity, false);
  // Only an unpublished partial allocation or a verified-clean removal may be repaired.
  // Quarantine remaining source; never delete task/report files or an unrelated worktree.
  if (fs.existsSync(previousCheckout)) {
    directory(previousCheckout);
    const quarantine = path.join(previousWorkspace, 'recovery', previous.id);
    directory(path.dirname(quarantine));
    if (fs.existsSync(quarantine)) throw new Error('Workspace recovery quarantine already exists');
    fs.renameSync(previousCheckout, quarantine);
    syncDirectory(previousWorkspace);
  }
  const adminRoot = path.join(cache, 'worktrees');
  if (fs.existsSync(adminRoot)) directory(adminRoot);
  if (fs.existsSync(adminRoot)) for (const name of fs.readdirSync(adminRoot)) {
    const admin = path.join(adminRoot, name);
    directory(admin);
    const gitdir = path.join(admin, 'gitdir');
    if (fs.existsSync(gitdir) && !fs.lstatSync(gitdir).isSymbolicLink() && [path.join(previousCheckout,'.git'),path.join(fs.realpathSync(previousWorkspace),'source','.git')].includes(fs.readFileSync(gitdir,'utf8').trim())) fs.rmSync(admin, {recursive:true});
  }
  write(path.join(ownerPath, 'repair.json'), {workspaceId:previous.identity.workspaceId, sourceRetained:true, at:new Date().toISOString()});
}
async function recover(previousPath) {
  if (!previousPath) return;
  const previous = read(path.join(previousPath, 'operation.json'));
  if (!previous || previous.cacheKey !== cacheKey) throw new Error('Allocator operation belongs to another cache');
  const state = read(path.join(previousPath, 'state.json'));
  if (state?.state === 'complete' || read(path.join(previousPath, 'recovered.json'))) return;
  if (matches(census().get(previous.process.pid), previous.process)) throw pending(previous);
  await recover(previous.previousPath);
  await stopCommands(previousPath);
  for (const command of commandDirectories(previousPath)) {
    const request = read(path.join(command, 'request.json'));
    const result = read(path.join(command, 'result.json'));
    if (request && (!result?.stopped || result.code !== 0)) {
      const baseline = new Set(request.lockBaseline);
      for (const relative of lockFiles()) if (!baseline.has(relative)) fs.unlinkSync(path.join(cache, relative));
    }
  }
  if (commandDirectories(previousPath).length) marker(path.join(root,'repositories',cacheKey+'.json'),cacheIdentity,false);
  repairPartialWorktree(previous, previousPath);
  write(path.join(previousPath, 'recovered.json'), {by:operation.id, at:new Date().toISOString()});
}
function claim() {
  const id = crypto.randomUUID();
  operationPath = path.join(operations, id);
  directory(operationPath);
  const owner = census().get(process.pid);
  if (!owner) throw new Error('Allocator process identity is unavailable');
  operation = {id, cacheKey, identity, generation:input.generation, process:owner, action:input.action, startedAt:new Date().toISOString()};
  write(path.join(operationPath, 'operation.json'), operation);
  while (true) {
    let previousPath;
    try { previousPath = linkTarget(lock); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previousPath) {
      while (fs.existsSync(path.join(previousPath, 'next'))) previousPath = linkTarget(path.join(previousPath, 'next'));
      const previous = read(path.join(previousPath, 'operation.json'));
      const state = read(path.join(previousPath, 'state.json'));
      if (!previous || previous.cacheKey !== cacheKey) throw new Error('Invalid allocator owner');
      if (state?.state !== 'complete' && matches(census().get(previous.process.pid), previous.process)) throw pending(previous);
    }
    operation.previousPath = previousPath;
    write(path.join(operationPath, 'operation.json'), operation);
    try { fs.symlinkSync(operationPath, previousPath ? path.join(previousPath, 'next') : lock); }
    catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    // The immutable successor claim serializes recovery too. A crashed recovery
    // owner is replaced through its own successor, never by unlinking another claim.
    const shortcut = lock + '.' + id;
    fs.symlinkSync(operationPath, shortcut);
    fs.renameSync(shortcut, lock);
    syncDirectory(path.dirname(lock));
    return previousPath;
  }
}
async function git(args, phase = 'inspect') {
  assertWorkspaceOperationCurrent();
  if (phase === 'inspect') {
    // These fixed local queries cannot fetch, mutate refs or refresh the index.
    const result = spawnSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args], {env:environment,encoding:'utf8',timeout:10000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']});
    if (result.error || result.status !== 0) throw result.error || new Error(result.stderr || 'Git inspection failed');
    return result.stdout.trim();
  }
  const command = path.join(operationPath, 'commands', crypto.randomUUID());
  directory(command);
  write(path.join(command, 'request.json'), {phase, args, lockBaseline:lockFiles()});
  const child = spawn(process.execPath, ['-e', GIT_SUPERVISOR_SCRIPT, JSON.stringify({directory:command, args:['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','gc.auto=0','-c','maintenance.auto=false','-c','protocol.ext.allow=never',...args], environment})], {detached:true, stdio:['ignore','pipe','pipe','ipc']});
  let stdout = '', stderr = '';
  let cancellationTimer;
  let commandCancelled = false;
  const result = await new Promise((resolve, reject) => {
    if (!input.allowCancelled) cancellationTimer = setInterval(() => {
      try { assertWorkspaceOperationCurrent(); }
      catch (error) { commandCancelled = true; reject(error); }
    }, 100);
    let outputBytes = 0;
    const append = (stream, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > 1024*1024) {reject(new Error('Git output exceeded 1 MiB')); return;}
      if (stream === 'stdout') stdout += chunk; else stderr += chunk;
    };
    child.stdout.on('data', (chunk) => append('stdout',chunk));
    child.stderr.on('data', (chunk) => append('stderr',chunk));
    child.once('error', reject);
    child.once('message', (message) => {
      try {
        if (commandCancelled) { child.disconnect(); return; }
        const supervisor = read(path.join(command, 'supervisor.json'));
        if (message !== 'ready' || !supervisor || !matches(census().get(child.pid), supervisor)) throw new Error('Git supervisor identity is unconfirmed');
        child.send('start');
      } catch (error) { reject(error); }
    });
    child.once('close', (code) => resolve(code));
  }).finally(() => clearInterval(cancellationTimer));
  const supervisor = read(path.join(command, 'supervisor.json'));
  if (supervisor) await stopGroup(supervisor, read(path.join(command, 'git.json')));
  if (result !== 0) throw new Error(stderr || 'Git command failed');
  return stdout.trim();
}
async function verifyCheckout() {
  directory(checkout);
  const gitFile = path.join(checkout, '.git');
  const stat = fs.lstatSync(gitFile);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Checkout has no owned worktree binding');
  const common = await git(['-C',checkout,'rev-parse','--path-format=absolute','--git-common-dir']);
  if (fs.realpathSync(common) !== fs.realpathSync(cache)) throw new Error('Checkout belongs to another repository');
  if (await git(['-C',checkout,'rev-parse','HEAD']) !== identity.headSha) throw new Error('Checkout HEAD no longer matches frozen review');
  if (await git(['-C',checkout,'status','--porcelain','--untracked-files=normal','--ignored=matching'])) throw new Error('Review checkout changed; refusing to discard files');
}
(async () => {
  directory(root);
  for (const name of ['runs','repositories','locks','operations']) directory(path.join(root,name));
  if (input.action === 'cancel') {
    const identityPath = path.join(workspace,'identity.json');
    if (fs.existsSync(workspace) && !fs.existsSync(identityPath) && fs.readdirSync(workspace).length) throw new Error('Workspace directory has no ownership marker');
    directory(workspace);
    marker(identityPath, identity, true);
    marker(cancellationPath, identity, true);
    process.stdout.write(JSON.stringify({state:'cancelled'}));
    return;
  }
  assertWorkspaceOperationCurrent();
  const previousPath = claim();
  await recover(previousPath);
  const identityPath = path.join(workspace,'identity.json');
  if (fs.existsSync(workspace) && !fs.existsSync(identityPath) && fs.readdirSync(workspace).length) throw new Error('Workspace directory has no ownership marker');
  directory(workspace);
  marker(identityPath,identity,input.action === 'allocate');
  const receiptPath = path.join(workspace,'allocation.json');
  const previous = read(receiptPath);
  // Cancellation can win before allocation creates either a cache or a receipt.
  if (input.action === 'cleanup' && (!previous || previous.state === 'cleaned') && !fs.existsSync(checkout) && same(read(cancellationPath), identity)) {
    write(receiptPath,{state:'cleaned',operationId:operation.id,updatedAt:new Date().toISOString()});
    write(path.join(operationPath,'state.json'),{state:'complete'});
    process.stdout.write(JSON.stringify({state:'cleaned'}));
    return;
  }
  const cacheMarker = path.join(root,'repositories',cacheKey+'.json');
  if (fs.existsSync(cache) && !fs.existsSync(cacheMarker)) throw new Error('Review cache has no ownership marker');
  marker(cacheMarker,cacheIdentity,input.action === 'allocate');
  if (input.action === 'cleanup') {
    if (!previous) throw new Error('Workspace allocation has no durable receipt');
    if (previous.state === 'cleaned' && fs.existsSync(checkout)) throw new Error('Cleaned checkout was replaced');
    if (previous.state !== 'cleaned' && fs.existsSync(checkout)) {
      if (previous.state !== 'cleaning') await verifyCheckout();
      write(receiptPath,{state:'cleaning',operationId:operation.id});
      await git(['--git-dir',cache,'worktree','remove',checkout], 'remove-worktree');
    }
    write(receiptPath,{state:'cleaned',operationId:operation.id,updatedAt:new Date().toISOString()});
    write(path.join(operationPath,'state.json'),{state:'complete'});
    process.stdout.write(JSON.stringify({state:'cleaned'}));
  } else if (input.action === 'allocate') {
    if (['cleaned','cleaning'].includes(previous?.state)) throw new Error('Workspace was cleaned; create a new review run');
    directory(path.join(workspace,'task'));
    directory(path.join(workspace,'task','artifacts'));
    if (previous?.state !== 'ready') write(receiptPath,{state:'allocating',operationId:operation.id});
    // Reinitialization repairs interrupted creation and preserves existing bare-cache objects/refs.
    if (fs.existsSync(cache)) directory(cache);
    if (!['config','HEAD','objects'].every((name) => fs.existsSync(path.join(cache,name))))
      await git(['init','--bare',cache], 'init-cache');
    directory(cache);
    if (await git(['--git-dir',cache,'rev-parse','--is-bare-repository']) !== 'true') throw new Error('Review cache is not bare');
    if (!(await git(['--git-dir',cache,'remote']))) await git(['--git-dir',cache,'remote','add','origin',identity.repositoryUrl], 'configure-cache');
    if (await git(['--git-dir',cache,'remote','get-url','origin']) !== identity.repositoryUrl) throw new Error('Review cache origin changed');
    if (previous?.state !== 'ready') {
      await git(['--git-dir',cache,'fetch','--no-tags','origin',identity.headSha,identity.baseSha], 'fetch');
      for (const [kind,sha] of [['head',identity.headSha],['base',identity.baseSha]]) {
        if (await git(['--git-dir',cache,'rev-parse',sha+'^{commit}']) !== sha) throw new Error('Review ref is not the exact commit');
        await git(['--git-dir',cache,'update-ref','refs/reviews/'+identity.workspaceId+'/'+kind,sha], 'retain-ref');
      }
    }
    if (!fs.existsSync(checkout)) await git(['--git-dir',cache,'worktree','add','--detach',checkout,identity.headSha], 'add-worktree');
    await verifyCheckout();
    assertWorkspaceOperationCurrent();
    write(receiptPath,{state:'ready',operationId:operation.id,updatedAt:new Date().toISOString()});
    write(path.join(operationPath,'state.json'),{state:'complete'});
    process.stdout.write(JSON.stringify({state:'ready'}));
  } else throw new Error('Unknown workspace operation');
})().catch(async (error) => {
  if (operationPath && fs.existsSync(path.join(operationPath,'commands'))) {
    try { await stopCommands(operationPath); }
    catch (cleanupError) { error = new Error(error.message + '; owned Git cleanup: ' + cleanupError.message); }
  }
  process.stderr.write(error.message);
  process.stdout.write(JSON.stringify({error:{code:error.code || 'REVIEW_WORKSPACE_ALLOCATION_FAILED',message:error.message}}));
  process.exitCode = 1;
});
`;
