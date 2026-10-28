import path from 'node:path';

import { shellQuote } from '../core/tmux.js';

export interface WorkerSourceExpectation {
  cliVersion: string;
  protocolVersion: string;
  wireVersion: string;
  runtimeScript: string;
  taskDir: string | null;
}

/** Verify retained templates/libraries through their existing provenance owner, never current main. */
export function workerSourceProbeCommand(expected: WorkerSourceExpectation): string {
  const runtimeModule = path.posix.join(
    path.posix.dirname(expected.runtimeScript),
    '../dist/index.js',
  );
  const program = String.raw`
const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module'),{pathToFileURL}=require('node:url');
(async()=>{
 const expected=JSON.parse(process.argv[1]),cliPath=process.argv[2];
 const warnings=[];
 const result=(status,detail,retry)=>{
  if(warnings.length){detail='Package version warning: '+warnings.join('; ')+'. '+detail;if(status==='verified'){status='unverified';retry=false}}
  process.stdout.write(JSON.stringify({status,detail,...(retry===false?{retry:false}:{})}));
 };
 if(!cliPath){result('mismatch','Worker farmslot CLI is missing. Install the matching CLI through the supported update route and retry this run.');return}
 const cli=fs.realpathSync(cliPath);
 const manifest=(file,name)=>{let root=path.dirname(file);for(;;){const p=path.join(root,'package.json');if(fs.existsSync(p)){const v=JSON.parse(fs.readFileSync(p,'utf8'));if(v.name===name)return v}const parent=path.dirname(root);if(parent===root)return null;root=parent}};
 const cliPackage=manifest(cli,'@farmslot/cli');
 if(!cliPackage){result('unverified','Selected CLI has no readable package identity.');return}
 const requireCLI=createRequire(cli),protocolEntry=requireCLI.resolve('@farmslot/protocol');
 const protocolPackage=manifest(protocolEntry,'@farmslot/protocol'),protocol=await import(pathToFileURL(protocolEntry).href);
 if(!protocolPackage){result('mismatch','Selected protocol has no readable package identity. Install the CLI/helpers through the supported update route and retry this run.');return}
 for(const [name,actual,wanted] of [['CLI',cliPackage.version,expected.cliVersion],['protocol package',protocolPackage?.version,expected.protocolVersion]]){
  if(actual!==wanted)warnings.push(name+' resolved '+actual+'; expected '+wanted);
 }
 if(protocol.PROTOCOL_VERSION!==expected.wireVersion){result('mismatch','node wire protocol resolved '+protocol.PROTOCOL_VERSION+'; expected '+expected.wireVersion+'. Install compatible node/CLI helpers through the supported update route and retry this run.');return}
 if(!expected.taskDir){result('unverified','No retained task source receipt is bound to this launch.',false);return}
 const receiptFile=path.join(expected.taskDir,'artifacts/harness-provenance.json');
 if(!fs.existsSync(receiptFile)){result('unverified','This task has no retained source receipt; existing source admission still applies.',false);return}
 const receipt=JSON.parse(fs.readFileSync(receiptFile,'utf8'));
 const runtime=await import(pathToFileURL(expected.runtimeModule).href);
 try{runtime.verifyTaskExecutionProvenance(expected.taskDir,receipt.bindingIdentity??null)}catch(e){
  if(e.code==='TASK_PROVENANCE_LEGACY'){result('unverified',e.message,false);return}
  if((e.exitCode===5 && typeof e.code==='string') || e.code==='ENOENT'){result('mismatch',e.code+': '+e.message+' Repair the retained input through its supported source owner, then retry this same run.');return}
  throw e;
 }
 result('verified','Selected CLI/protocol and retained pack/template/library bytes match their receipts.');
})().catch(e=>{process.stdout.write(JSON.stringify({status:'unverified',detail:e.message}));});`;
  const packet = JSON.stringify({ ...expected, runtimeModule });
  return `node -e ${shellQuote(program)} ${shellQuote(packet)} "\${FARMSLOT_CLI:-$(command -v farmslot)}"`;
}
