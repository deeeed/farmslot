import type { AssessmentTestParams } from '@farmslot/protocol';

import { assess, assessmentProviderStatus } from '../assessment/index.js';

/** Local credential presence only; no provider request and no configuration write. */
export const assessmentStatus = assessmentProviderStatus;

export async function assessmentTest(params: AssessmentTestParams = {}) {
  if (
    !params ||
    typeof params !== 'object' ||
    Array.isArray(params) ||
    Object.keys(params).some((key) => !['provider', 'model'].includes(key)) ||
    Object.values(params).some(
      (value) => typeof value !== 'string' || !/^[\w.-]{1,100}$/.test(value),
    )
  ) {
    throw new Error('Invalid assessment test parameters');
  }
  return assess({
    ...params,
    enabled: true,
    state: { color: 'blue' },
    questions: {
      color: {
        type: 'choice',
        instructions: 'Which color is supplied in the state?',
        criteria: { blue: 'Blue', red: 'Red' },
      },
    },
  });
}
