import {
  registerProducingWorkerScope,
  workerResumeModes,
} from './filesystem-policy.test-support.js';

registerProducingWorkerScope(workerResumeModes[0]);
