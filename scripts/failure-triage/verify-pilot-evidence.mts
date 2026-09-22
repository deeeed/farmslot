import { verifyTriagePilotEvidence } from '../../services/gateway/src/assessment/failure-triage/pilot-evidence.js';

const directory = process.argv[2];
if (!directory || process.argv.length !== 3)
  throw new Error('Provide one evaluation receipt directory');
console.log(JSON.stringify(await verifyTriagePilotEvidence(directory), null, 2));
