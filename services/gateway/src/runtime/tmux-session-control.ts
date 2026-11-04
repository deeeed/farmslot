import type { TmuxWorkerEndSessionParams } from '@farmslot/protocol';

/** Execute on the owning node. The tmux queue checks identity immediately before ending the session. */
export function endTmuxSessionArgv(params: TmuxWorkerEndSessionParams): string[] {
  const { worker, expectedPid } = params;
  if (
    !worker?.nodeId ||
    !worker.session ||
    !/^%\d+$/.test(worker.paneId ?? '') ||
    !Number.isSafeInteger(expectedPid) ||
    expectedPid < 1
  )
    throw new Error('Ending a session requires its current pane ID and process ID');
  const script = String.raw`
const cp=require('node:child_process');
const {worker,expectedPid}=JSON.parse(process.argv[1]);
const tmux=args=>{const r=cp.spawnSync('tmux',args,{encoding:'utf8'});if(r.error)throw r.error;if(r.status!==0)throw Error(r.stderr||'Tmux operation failed');return r.stdout.trimEnd();};
const [pid,sessionId,...name]=tmux(['display-message','-p','-t',worker.paneId,'#{pane_pid}\t#{session_id}\t#{session_name}']).split('\t');
if(Number(pid)!==expectedPid||name.join('\t')!==worker.session||!/^\$\d+$/.test(sessionId))throw Error('Session changed; refresh before ending it');
const condition='#{&&:#{==:#{pane_pid},'+expectedPid+'},#{==:#{session_id},'+sessionId+'}}';
const result=tmux(['if-shell','-F','-t',worker.paneId,condition,"kill-session -t '"+sessionId+"'",'display-message -p session-changed']);
if(result)throw Error('Session changed; refresh before ending it');
process.stdout.write(JSON.stringify({ok:true}));
`;
  return ['node', '-e', script, JSON.stringify(params)];
}

/** The owning node supplies its home and shell; no client command or cwd is executed. */
export function createTmuxSessionArgv(session: string): string[] {
  const script = String.raw`
const cp=require('node:child_process');
const session=process.argv[1];
const cwd=require('node:os').homedir();
const args=['new-session','-d','-s',session,'-c',cwd,'-P','-F','#{window_index}\t#{pane_index}\t#{pane_id}\t#{pane_pid}',process.env.SHELL||'/bin/sh'];
const r=cp.spawnSync('tmux',args,{encoding:'utf8'});
if(r.error)throw r.error;
if(r.status!==0)throw Error(r.stderr||'Could not create terminal');
const [window,pane,paneId,pid]=r.stdout.trim().split('\t');
const separator='<<FARMSLOT_TMUX_FIELD>>';
const metadata=cp.spawnSync('tmux',['display-message','-p','-t',paneId,['#{window_name}','#{pane_title}','#{pane_current_command}','#{pane_current_path}'].join(separator)],{encoding:'utf8'});
if(metadata.error)throw metadata.error;
if(metadata.status!==0)throw Error(metadata.stderr||'Could not inspect created terminal');
const [windowName,title,command,actualCwd]=metadata.stdout.trimEnd().split(separator);
process.stdout.write(JSON.stringify({session,window,pane,paneId,target:paneId,pid:Number(pid),cwd:actualCwd||cwd,windowName,title,command}));
`;
  return ['node', '-e', script, session];
}
