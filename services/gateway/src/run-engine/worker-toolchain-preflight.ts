import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { satisfies, valid, validRange } from 'semver';

import { isRecord } from '@farmslot/protocol';

import { shellQuote } from '../core/tmux.js';

import type { LaunchProbeResult } from './worker-preflight.js';

export interface LaunchPackDeclaration {
  fixturesDir: string;
  bound: boolean;
}

/** A current mutable pack cannot redefine the toolchain of a retained legacy task. */
export async function readLaunchPackPins(source: LaunchPackDeclaration): Promise<string | null> {
  if (!source.bound) return null;
  try {
    return await readFile(path.join(source.fixturesDir, '.tool-versions'), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return '';
    throw error;
  }
}

export type LaunchTool = 'node' | 'yarn' | 'yarnNode' | 'ruby';
export interface ToolVersion {
  version?: string;
  missing?: boolean;
  unavailable?: string;
  exitCode?: number;
}
export interface ToolRequirement {
  tool: 'node' | 'yarn' | 'ruby';
  range: string;
  source: string;
}
export interface ToolchainObservation {
  requirements: ToolRequirement[];
  tools: Record<LaunchTool, ToolVersion>;
}

/** Runs inside the same project and worker wrappers as the command being admitted. */
export function toolchainProbeCommand(packPins: string): string {
  const program = String.raw`
const fs=require('node:fs'), cp=require('node:child_process');
const read=(file)=>{try{return fs.readFileSync(file,'utf8').trim()}catch(e){if(e.code==='ENOENT')return '';throw e}};
const requirements=[];
const rubyDeclared=/^\s*ruby\s+\S+/m.test(process.argv[1]);
const add=(tool,range,source)=>{if(range)requirements.push({tool,range,source})};
const pins=(text,source)=>{for(const row of text.split(/\n/)){const [tool,version]=row.trim().split(/\s+/);if(tool==='nodejs')add('node',version,source);if(tool==='ruby' && rubyDeclared)add('ruby',version,source);if(tool==='yarn')add('yarn',version,source)}};
const raw=read('package.json'),pkg=raw?JSON.parse(raw):{};
add('node',read('.nvmrc'),'.nvmrc');
add('node',pkg.engines?.node,'package.json engines.node');
add('yarn',pkg.engines?.yarn,'package.json engines.yarn');
if(typeof pkg.packageManager==='string' && pkg.packageManager.startsWith('yarn@'))add('yarn',pkg.packageManager.slice(5).split('+')[0],'package.json packageManager');
pins(read('.tool-versions'),'.tool-versions');
if(rubyDeclared)add('ruby',read('.ruby-version'),'.ruby-version');
pins(process.argv[1],'selected pack toolchain pins');
const probe=(binary,args)=>{const r=cp.spawnSync(binary,args,{encoding:'utf8',env:{...process.env,COREPACK_ENABLE_NETWORK:'0'}});if(r.error?.code==='ENOENT')return {missing:true};if(r.error || r.status!==0)return {unavailable:r.error?.message || 'probe exited '+r.status,...(Number.isInteger(r.status)?{exitCode:r.status}:{})};return {version:r.stdout.trim()}};
const tools={node:{version:process.version},yarn:{},yarnNode:{},ruby:{}};
if(requirements.some(r=>r.tool==='node'||r.tool==='yarn')){
 tools.yarn=probe('yarn',['--version']);
 tools.yarnNode=probe('yarn',['node','-p','process.version']);
}
if(requirements.some(r=>r.tool==='ruby'))tools.ruby=probe('ruby',['-e','print RUBY_VERSION']);
process.stdout.write(JSON.stringify({requirements,tools}));`;
  // The shell can prove a missing interpreter before JavaScript can read declarations.
  return `if command -v node >/dev/null 2>&1; then node -e ${shellQuote(program)} ${shellQuote(packPins)}; else printf '%s' '{"nodeMissing":true}'; fi`;
}

function toolVersion(value: unknown): ToolVersion | undefined {
  if (!isRecord(value)) return undefined;
  if (value.missing === true) return { missing: true };
  if (typeof value.version === 'string') return { version: value.version };
  if (typeof value.unavailable === 'string')
    return {
      unavailable: value.unavailable,
      ...(Number.isInteger(value.exitCode) && typeof value.exitCode === 'number'
        ? { exitCode: value.exitCode }
        : {}),
    };
  if (Object.keys(value).length === 0) return {};
  return undefined;
}

export function parseToolchainObservation(raw: string): ToolchainObservation | undefined {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value) || !Array.isArray(value.requirements) || !isRecord(value.tools))
    return undefined;
  const requirements: ToolRequirement[] = [];
  for (const entry of value.requirements) {
    if (
      !isRecord(entry) ||
      !['node', 'yarn', 'ruby'].includes(String(entry.tool)) ||
      typeof entry.range !== 'string' ||
      typeof entry.source !== 'string'
    )
      return undefined;
    if (entry.tool !== 'node' && entry.tool !== 'yarn' && entry.tool !== 'ruby') return undefined;
    requirements.push({ tool: entry.tool, range: entry.range, source: entry.source });
  }
  const node = toolVersion(value.tools.node);
  const yarn = toolVersion(value.tools.yarn);
  const yarnNode = toolVersion(value.tools.yarnNode);
  const ruby = toolVersion(value.tools.ruby);
  return node && yarn && yarnNode && ruby
    ? { requirements, tools: { node, yarn, yarnNode, ruby } }
    : undefined;
}

export function checkToolchainObservation(
  observation: ToolchainObservation,
  slotId: string,
  packDeclarationVerified = true,
): LaunchProbeResult {
  const unverified: string[] = [];
  for (const requirement of observation.requirements) {
    const tools: LaunchTool[] =
      requirement.tool === 'node' ? ['node', 'yarnNode'] : [requirement.tool];
    for (const tool of tools) {
      const actual = observation.tools[tool];
      const correction = `Run the selected pack setup/check-paths in ${slotId} and retry this run`;
      if (actual.missing)
        return {
          status: 'mismatch',
          detail: `${slotId} ${tool} is missing; expected ${requirement.range} from ${requirement.source}. ${correction}.`,
        };
      if (actual.exitCode !== undefined && actual.exitCode !== 0)
        return {
          status: 'mismatch',
          detail: `${slotId} ${tool} exited ${actual.exitCode}; expected ${requirement.range} from ${requirement.source}. ${correction}.`,
        };
      if (!actual.version) {
        unverified.push(`${tool}: ${actual.unavailable ?? 'version unavailable'}`);
        continue;
      }
      if (!valid(actual.version)) {
        unverified.push(`${tool}: unreadable version ${actual.version}`);
        continue;
      }
      const range = validRange(requirement.range);
      if (!range) {
        unverified.push(
          `${requirement.source}: unsupported version declaration ${requirement.range}`,
        );
        continue;
      }
      if (!satisfies(actual.version, range))
        return {
          status: 'mismatch',
          detail: `${slotId} ${tool} resolved ${actual.version}; expected ${requirement.range} from ${requirement.source}. ${correction}.`,
        };
    }
  }
  if (!unverified.length && !packDeclarationVerified)
    return {
      status: 'unverified',
      detail:
        'Product toolchains match; this legacy task has no bound pack toolchain declaration. Retained inputs were preserved.',
      retry: false,
    };
  return unverified.length
    ? { status: 'unverified', detail: unverified.join('; ') }
    : {
        status: 'verified',
        detail: observation.requirements.length
          ? 'Declared Node, Yarn/child Node and Ruby versions match the launch shell.'
          : 'No toolchain versions declared.',
      };
}
