import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface SourceProofConnection {
  port: number;
  token: string;
  runId: string;
  nodeId: string;
}

/** Credentials remain in the owned, mode-0600 file and child-process environment. */
export async function readSourceProofConnection(output: string): Promise<SourceProofConnection> {
  return JSON.parse(await readFile(path.join(output, 'client-connection.json'), 'utf8'));
}
