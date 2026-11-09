import { currentFarmPaths } from './farm-paths.js';
import { homedir } from 'node:os';
import path from 'node:path';

export function expandHome(value: string): string {
  return value === '~' || value.startsWith('~/') ? path.join(homedir(), value.slice(1)) : value;
}

export function farmslotHome(env: NodeJS.ProcessEnv = process.env): string {
  return currentFarmPaths('node', env).home;
}
