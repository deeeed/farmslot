// Fixture-only GitHub responses. Unknown operations fail closed.
export function recoveryGithub(holds: string): string {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const holds = ${JSON.stringify(holds)};
const args = process.argv.slice(2);
fs.appendFileSync(path.join(holds,'github.jsonl'), JSON.stringify(args)+'\\n');
const out = value => { process.stdout.write((args[0]==='api' && args.includes('--include')?'HTTP/2.0 200 OK\\r\\ncontent-type: application/json\\r\\n\\r\\n':'')+(typeof value==='string'?value+'\\n':JSON.stringify(value)+'\\n')); process.exit(0); };
if(args[0]==='pr' && args[1]==='edit') out('');
if(args[0]==='pr' && args[1]==='list') out(args.includes('--jq')?null:[]);
const number = args.some(a => /102/.test(a)) ? 102 : 101;
const repo = path.join(path.dirname(holds),'slots',number===102?'recovery-fixer-scope-1':'recovery-node-timeout-1');
const head = execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim();
const branch = execFileSync('git',['branch','--show-current'],{cwd:repo,encoding:'utf8'}).trim();
const base = execFileSync('git',['rev-parse','origin/main'],{cwd:repo,encoding:'utf8'}).trim();
if(args[0]==='pr' && args[1]==='checks') out('fixture\\t'+(number===102?'fail':'pending')+'\\t2026-11-05T00:00:00Z\\t');
if(args[0]==='pr' && args[1]==='view') {
 if(args.includes('--jq') && args[args.indexOf('--jq')+1]==='.headRefOid') out(head);
 if(args.includes('--jq')) out(['OPEN','MERGEABLE','CLEAN','',branch,'2026-11-05T00:00:00Z','2026-11-05T00:00:00Z','','','Recovery fixture'].join('\\t')+'\\nfixture');
 out({number,state:'OPEN',mergeable:'MERGEABLE',mergeStateStatus:'CLEAN',headRefName:branch,headRefOid:head,baseRefName:'main',url:'https://github.com/fixture/recovery/pull/'+number,title:'Recovery fixture',body:'Fixture',statusCheckRollup:[]});
}
if(args[0]==='api') {
 const endpoint = args.find(a=>a.startsWith('repos/'));
 if (/\\/reviews\\?per_page=100$/.test(endpoint??'')) out([[]]);
 if(args.includes('graphql') || /\\/(comments|reviews)$/.test(endpoint??'')) out('');
 if(/\\/issues\\/\\d+$/.test(endpoint??'')) out({title:'Recovery fixture',body:'Fixture',labels:[],state:'open'});
 if(/\\/commits$/.test(endpoint??'')) out('2026-11-05T00:00:00Z');
 if(/\\/compare\\//.test(endpoint??'')) out({files:[],commits:[]});
 if(/\\/files$/.test(endpoint??'')) out([]);
 if(/\\/pulls\\/\\d+$/.test(endpoint??'')) {
   const jq = args[args.indexOf('--jq')+1];
   if(args.includes('--jq') && jq==='.state') out('open');
   if(args.includes('--jq') && jq.includes('head:.head.ref')) out({state:'open',head:branch,base:'main'});
   out({number,state:'open',title:'Recovery fixture',body:'Fixture',html_url:'https://github.com/fixture/recovery/pull/'+number,merged:false,merged_at:null,head:{ref:branch,sha:head,repo:{full_name:'fixture/recovery'}},base:{ref:'main',sha:base,repo:{full_name:'fixture/recovery'}}});
 }
}
console.error('Unsupported fixture GitHub operation: '+JSON.stringify(args));process.exit(2);
`;
}
