import { Platform } from 'react-native';

import {
  createNativeSqliteResourceStore,
  nativeResourceStoreDiagnostics,
} from '@farmslot/local-store/native';
import { runResourceStoreConformance } from '@farmslot/protocol/client-cache';

import { getResourceCache, getResourceStoreNotice } from '../lib/resource-cache';

import type { FarmslotRecipeUiObserver } from './RecipeBridgeProvider';

export const observeLocalStoreProof: FarmslotRecipeUiObserver = async (refs) => {
  if (!__DEV__ || refs.length !== 1 || !refs[0].startsWith('local-store:')) return undefined;
  try {
    if (refs[0] === 'local-store:conformance') {
      const passed = await runResourceStoreConformance((scope) =>
        createNativeSqliteResourceStore({ scope, databaseName: 'conformance.sqlite' }),
      );
      return {
        observations: {
          localStore: {
            result: 'PASS',
            platform: Platform.OS,
            checks: passed.length,
            diagnostics: await nativeResourceStoreDiagnostics('conformance.sqlite'),
          },
        },
      };
    }
    return {
      observations: {
        localStore: {
          result: 'PASS',
          platform: Platform.OS,
          cache: Boolean(getResourceCache()),
          notice: getResourceStoreNotice(),
          diagnostics: await nativeResourceStoreDiagnostics(),
        },
      },
    };
  } catch (error) {
    // A failed SQL proof must reach the runner as a failure receipt, rather than a relay timeout.
    return {
      observations: {
        localStore: {
          result: 'FAIL',
          platform: Platform.OS,
          message: error instanceof Error ? error.message : String(error),
        },
      },
    };
  }
};
