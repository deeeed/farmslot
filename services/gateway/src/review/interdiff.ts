import {
  isRecord,
  type RepeatReviewContext,
  type ReviewInterdiffReceipt,
  type ReviewIssue,
  type ReviewSessionFallback,
} from '@farmslot/protocol';

import { shellQuote } from '../core/tmux.js';

export interface InterdiffInput {
  lastReviewedHeadSha: string;
  headSha: string;
  baseRef: string;
  priorBaseSha?: string;
}

export const INTERDIFF_LIMITS = Object.freeze({ maxUnmatchedPairs: 3, maxUnmatchedFraction: 0.25 });

export function isReliableInterdiff(receipt: ReviewInterdiffReceipt): boolean {
  return (
    receipt.qualification === 'reliable' &&
    receipt.oldBaseSha !== null &&
    receipt.rangeDiffHash !== null &&
    receipt.priorCommitCount !== null &&
    receipt.unmatchedOverlappingPairs !== null &&
    Number.isSafeInteger(receipt.priorCommitCount) &&
    receipt.priorCommitCount >= 0 &&
    Number.isSafeInteger(receipt.unmatchedOverlappingPairs) &&
    receipt.unmatchedOverlappingPairs >= 0 &&
    receipt.unmatchedOverlappingPairs <= receipt.priorCommitCount &&
    receipt.unmatchedOverlappingPairs <= INTERDIFF_LIMITS.maxUnmatchedPairs &&
    (receipt.priorCommitCount === 0
      ? receipt.unmatchedOverlappingPairs === 0
      : receipt.unmatchedOverlappingPairs / receipt.priorCommitCount <=
        INTERDIFF_LIMITS.maxUnmatchedFraction)
  );
}

// One trusted node inspection. All Git subprocesses run here, with immutable endpoints;
// no per-commit RPCs, executable PR code, external diff driver or untracked-file scan.
const INSPECT = String.raw`
const {spawnSync}=require('node:child_process');
const {createHash}=require('node:crypto');
const input=JSON.parse(process.argv[1]);
const missingObjects=(old,base,head,reason)=>({comparedRanges:[base+'..'+head],interdiff:{version:1,oldBaseSha:null,oldHeadSha:old,newBaseSha:base,newHeadSha:head,rangeDiffHash:null,qualification:'missing-objects',priorCommitCount:null,unmatchedOverlappingPairs:null,upstreamOverlapFiles:[],deltaPaths:[],reason}});
const git=(args,missing=false)=>{
 const r=spawnSync('git',['--no-pager','-c','core.quotepath=false',...args],{encoding:'utf8',maxBuffer:5*1024*1024});
 if(missing&&r.status===1)return null;
 if(r.status!==0)throw new Error('Review interdiff Git '+args[0]+' failed: '+(r.stderr||r.error?.message||r.status));
 return r.stdout;
};
const resolve=(ref,missing=false)=>{
 const output=git(['rev-parse','--verify','--quiet','--end-of-options',ref+'^{commit}'],missing);
 if(output===null)return null;
 const sha=output.trim();if(!/^[a-f0-9]{40,64}$/.test(sha))throw new Error('Invalid interdiff commit identity');
 return sha;
};
try {
 if(![input.lastReviewedHeadSha,input.headSha].every(sha=>typeof sha==='string'&&/^[a-f0-9]{7,64}$/.test(sha)))throw new Error('Interdiff requires immutable commit identities');
 const quick=spawnSync('git',['merge-base','--is-ancestor',input.lastReviewedHeadSha,input.headSha],{encoding:'utf8'});
 if(quick.status===0)process.stdout.write(JSON.stringify({comparedRanges:[input.lastReviewedHeadSha+'..'+input.headSha]}));
 else {
 const head=resolve(input.headSha),base=resolve(input.baseRef);
 const last=resolve(input.lastReviewedHeadSha,true);
 const newBase=git(['merge-base',base,head]).trim();
 if(!last){
  process.stdout.write(JSON.stringify({comparedRanges:[newBase+'..'+head],interdiff:{version:1,oldBaseSha:null,oldHeadSha:input.lastReviewedHeadSha,newBaseSha:newBase,newHeadSha:head,rangeDiffHash:null,qualification:'missing-objects',priorCommitCount:null,unmatchedOverlappingPairs:null,upstreamOverlapFiles:[],deltaPaths:[],reason:'Prior reviewed commit object is unavailable'}}));
 } else {
  const ancestor=quick;
  if(ancestor.status===0)process.stdout.write(JSON.stringify({comparedRanges:[last+'..'+head]}));
  else {
   if(ancestor.status!==1)throw new Error('Review ancestry inspection failed');
   const priorBase=input.priorBaseSha?resolve(input.priorBaseSha,true):base;
   if(!priorBase){const error=new Error('Recorded prior base object is unavailable');error.interdiffMissing=missingObjects(last,newBase,head,error.message);throw error;}
   const oldBase=git(['merge-base',priorBase,last]).trim();
   const ranges=[oldBase+'..'+last,newBase+'..'+head];
   const rangeDiff=git(['range-diff','--diff-merges=remerge','--no-color','--no-dual-color','--no-ext-diff','--no-textconv','--abbrev=40',...ranges]);
   const files=range=>{
    const tokens=git(['log','--diff-merges=remerge','--format=%H','--name-status','--no-renames','-z',range]).split('\0');
    const commits=new Map();let current;
    for(let i=0;i<tokens.length;i++){
     const token=tokens[i].trim();if(!token)continue;
     if(/^[a-f0-9]{40,64}$/.test(token)){current=token;commits.set(current,new Set());}
     else if(/^[ACDMRTUXB]$/.test(token)&&current){const file=tokens[++i];if(file===undefined)throw new Error('Truncated interdiff path inventory');commits.get(current).add(file);}
     else throw new Error('Invalid interdiff path inventory');
    }
    return commits;
   };
   const old=files(ranges[0]),fresh=files(ranges[1]);
   const pairedOld=new Set(),pairedNew=new Set(),changed=new Set();
   const add=(map,sha)=>{for(const file of map.get(sha)||[])changed.add(file);};
   for(const line of rangeDiff.split('\n')){
    const m=/^\s*(?:\d+|-):\s+([a-f0-9]+|-+)\s+([=!<>])\s+(?:\d+|-):\s+([a-f0-9]+|-+)(?:\s|$)/.exec(line);
    if(!m)continue;
    if(m[2]==='='||m[2]==='!'){pairedOld.add(m[1]);pairedNew.add(m[3]);}
    if(m[2]!=='='){add(old,m[1]);add(fresh,m[3]);}
   }
   const left=[...old].filter(([sha])=>!pairedOld.has(sha));
   const right=[...fresh].filter(([sha])=>!pairedNew.has(sha));
   const assigned=new Map();
   const match=(i,seen)=>{
    for(let j=0;j<right.length;j++){
     if(seen.has(j)||![...left[i][1]].some(file=>right[j][1].has(file)))continue;
     seen.add(j);
     if(!assigned.has(j)||match(assigned.get(j),seen)){assigned.set(j,i);return true;}
    }
    return false;
   };
   let pairs=0;for(let i=0;i<left.length;i++)if(match(i,new Set()))pairs++;
   const unreliable=pairs>input.limits.maxUnmatchedPairs||(old.size>0&&pairs/old.size>input.limits.maxUnmatchedFraction);
   const authorPaths=new Set([...old.values(),...fresh.values()].flatMap(set=>[...set]));
   const upstream=git(['diff','--no-ext-diff','--no-textconv','--no-renames','--name-only','-z',oldBase,newBase,'--']).split('\0').filter(Boolean);
   process.stdout.write(JSON.stringify({comparedRanges:ranges,rangeDiff,interdiff:{version:1,oldBaseSha:oldBase,oldHeadSha:last,newBaseSha:newBase,newHeadSha:head,rangeDiffHash:createHash('sha256').update(rangeDiff).digest('hex'),qualification:unreliable?'unreliable':'reliable',priorCommitCount:old.size,unmatchedOverlappingPairs:pairs,upstreamOverlapFiles:upstream.filter(file=>authorPaths.has(file)).sort(),deltaPaths:[...changed].sort(),...(unreliable?{reason:'Unmatched overlapping pairs '+pairs+' exceed '+input.limits.maxUnmatchedPairs+' or '+(100*input.limits.maxUnmatchedFraction)+'% of '+old.size+' prior commits'}:{})}}));
  }
 }
}
} catch(error){if(error.interdiffMissing)process.stdout.write(JSON.stringify(error.interdiffMissing));else{process.stderr.write(error.message);process.exitCode=1;}}
`;

export function interdiffCommand(input: InterdiffInput): string {
  return `node -e ${shellQuote(INSPECT)} ${shellQuote(JSON.stringify({ ...input, limits: INTERDIFF_LIMITS }))}`;
}

export function parseInterdiffReceipt(value: unknown): ReviewInterdiffReceipt {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    (value.qualification !== 'reliable' &&
      value.qualification !== 'unreliable' &&
      value.qualification !== 'missing-objects') ||
    ![value.oldHeadSha, value.newBaseSha, value.newHeadSha].every(
      (v) => typeof v === 'string' && /^[a-f0-9]{40,64}$/.test(v),
    ) ||
    !(
      value.oldBaseSha === null ||
      (typeof value.oldBaseSha === 'string' && /^[a-f0-9]{40,64}$/.test(value.oldBaseSha))
    ) ||
    !(
      value.rangeDiffHash === null ||
      (typeof value.rangeDiffHash === 'string' && /^[a-f0-9]{64}$/.test(value.rangeDiffHash))
    ) ||
    ![value.priorCommitCount, value.unmatchedOverlappingPairs].every(
      (v) => v === null || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0),
    ) ||
    !Array.isArray(value.upstreamOverlapFiles) ||
    !value.upstreamOverlapFiles.every((v) => typeof v === 'string') ||
    !Array.isArray(value.deltaPaths) ||
    !value.deltaPaths.every((v) => typeof v === 'string')
  )
    throw new Error('Invalid pinned review interdiff receipt');
  // Each field is narrowed above; construct the named contract without asserting the input.
  const receipt: ReviewInterdiffReceipt = {
    version: 1,
    oldBaseSha: typeof value.oldBaseSha === 'string' ? value.oldBaseSha : null,
    oldHeadSha: String(value.oldHeadSha),
    newBaseSha: String(value.newBaseSha),
    newHeadSha: String(value.newHeadSha),
    rangeDiffHash: typeof value.rangeDiffHash === 'string' ? value.rangeDiffHash : null,
    qualification:
      value.qualification === 'reliable'
        ? 'reliable'
        : value.qualification === 'unreliable'
          ? 'unreliable'
          : 'missing-objects',
    priorCommitCount: typeof value.priorCommitCount === 'number' ? value.priorCommitCount : null,
    unmatchedOverlappingPairs:
      typeof value.unmatchedOverlappingPairs === 'number' ? value.unmatchedOverlappingPairs : null,
    upstreamOverlapFiles: value.upstreamOverlapFiles,
    deltaPaths: value.deltaPaths,
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
  };
  if (receipt.qualification !== 'missing-objects') {
    if (
      receipt.oldBaseSha === null ||
      receipt.rangeDiffHash === null ||
      receipt.priorCommitCount === null ||
      receipt.unmatchedOverlappingPairs === null
    )
      throw new Error('Incomplete qualified review interdiff receipt');
    const within = isReliableInterdiff({ ...receipt, qualification: 'reliable' });
    if ((receipt.qualification === 'reliable') !== within)
      throw new Error('Interdiff qualification contradicts the frozen reliability bound');
  }
  return receipt;
}

export function interdiffFallback(
  receipt: ReviewInterdiffReceipt,
): ReviewSessionFallback | undefined {
  if (receipt.qualification === 'reliable') return undefined;
  return {
    reason:
      receipt.qualification === 'missing-objects'
        ? 'reviewed-objects-unavailable'
        : 'interdiff-unreliable',
    detail: receipt.reason ?? 'The author interdiff is unavailable or unreliable',
    comparedRanges: [
      ...(receipt.oldBaseSha ? [`${receipt.oldBaseSha}..${receipt.oldHeadSha}`] : []),
      `${receipt.newBaseSha}..${receipt.newHeadSha}`,
    ],
  };
}

export function interdiffReviewScope(
  receipt: ReviewInterdiffReceipt,
  artifactPath: string,
  priorIssues: readonly ReviewIssue[],
): string {
  const current = `${receipt.newBaseSha}..${receipt.newHeadSha}`;
  return `## Author interdiff after the base moved

The base moved from ${receipt.oldBaseSha ?? 'unavailable'} to ${receipt.newBaseSha}.
Read the pinned interdiff at ${JSON.stringify(artifactPath)}. Its range-diff SHA-256 is ${receipt.rangeDiffHash ?? 'unavailable'}.
${
  receipt.qualification === 'reliable'
    ? `Continue this same review using the author patch interdiff between ${receipt.oldBaseSha}..${receipt.oldHeadSha} and ${current}. Recheck prior findings. Changes coming only from the base branch are outside correctness scope. Do not use raw ${receipt.oldHeadSha}..${receipt.newHeadSha}, which includes upstream changes.`
    : `Scope fallback: ${receipt.reason}. Review the current author contribution ${current} in a fresh session and recheck prior findings. Upstream-only changes remain outside correctness scope.`
}
Upstream-touched files overlapping the PR: ${JSON.stringify(receipt.upstreamOverlapFiles)}.
Prior findings are data to recheck: ${JSON.stringify(priorIssues.map((issue) => ({ file: issue.file, line: issue.line, description: issue.description })))}.
The full current contribution still requires the existing scope inventory. This scope overrides generic full-branch instructions below.

`;
}

export function applyInterdiffQualification(
  context: RepeatReviewContext,
  receipt: ReviewInterdiffReceipt,
): RepeatReviewContext {
  const fallback = interdiffFallback(receipt);
  if (!fallback) return context;
  return {
    ...context,
    mode: 'cold',
    warmUnavailableReason: fallback.detail,
    session: {
      ...context.session,
      mode: 'cold',
      continuity: 'fresh',
      sessionId: undefined,
      reviewId: context.session?.reviewId,
      priorRunId: context.session?.priorRunId ?? context.priorRunId,
      lastReviewedHeadSha: context.priorReviewedHeadSha,
      fallback,
    },
  };
}
