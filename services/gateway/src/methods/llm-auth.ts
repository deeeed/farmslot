// methods/llm-auth.ts — Gateway methods for LLM auth management

import {
  Events,
  type LLMAuthAddParams,
  type LLMAuthAddResult,
  type LLMAuthImportParams,
  type LLMAuthImportResult,
  type LLMAuthListResult,
  type LLMAuthLoginParams,
  type LLMAuthLoginProgress,
  type LLMAuthLoginResult,
  type LLMAuthRefreshParams,
  type LLMAuthRefreshResult,
  type LLMAuthRemoveParams,
  type LLMAuthRemoveResult,
  type LLMAuthTestParams,
  type LLMAuthTestResult,
} from '@farmslot/protocol';

import { refreshFarmslotProfiles } from '../llm/auth-refresh.js';
import { getProviderEnvVars, resolveAuth } from '../llm/auth-resolve.js';
import {
  type AuthProfileCredential,
  ensureAuthStoreFile,
  extractRawAccessToken,
  getFarmslotStorePath,
  getOpenClawStorePath,
  loadAuthProfileStore,
  type OAuthCredential,
  removeAuthProfile,
  saveAuthProfileStore,
  upsertAuthProfile,
  withFarmslotStoreLock,
} from '../llm/auth-store.js';
import { callLLM } from '../llm/index.js';

type Emit = (event: string, payload: unknown) => void;

// withFarmslotStoreLock now lives in `../llm/auth-store.ts` so the OAuth
// refresh path (`llm/auth-refresh.ts`) can share the same mutex. See its
// doc comment there for design intent.

/** OAuth provider id → pi-ai login function. Centralised so adding a provider
 * is a single-file change instead of a switch in `llmAuthLogin`.
 * pi-ai ≥0.82 hangs login off the provider's `auth.oauth` implementation. */
type OAuthLoginFn = (
  interaction: import('@earendil-works/pi-ai').AuthInteraction,
) => Promise<import('@earendil-works/pi-ai').OAuthCredentials>;
const OAUTH_LOGIN_HANDLERS: Record<string, () => Promise<OAuthLoginFn>> = {
  'openai-codex': async () => {
    const { openaiCodexProvider } = await import('@earendil-works/pi-ai/providers/openai-codex');
    const oauth = openaiCodexProvider().auth.oauth;
    if (!oauth) {
      throw new Error('pi-ai openai-codex provider exposes no oauth handler — library mismatch');
    }
    return (interaction) => oauth.login(interaction);
  },
};

/**
 * Default timeout for the entire OAuth login flow. The timeout aborts the
 * underlying pi-ai login via the interaction's AbortSignal, so the local
 * callback server releases port 1455 when it fires.
 */
const OAUTH_LOGIN_TIMEOUT_MS = Number(process.env.LLM_AUTH_LOGIN_TIMEOUT_MS ?? 5 * 60 * 1000);

export async function llmAuthList(): Promise<LLMAuthListResult> {
  const store = await loadAuthProfileStore(getFarmslotStorePath());
  const profiles = store
    ? Object.entries(store.profiles).map(([id, cred]) => {
        const base = {
          profileId: id,
          provider: cred.provider,
          type: cred.type,
          hasKey: !!extractRawAccessToken(cred),
        };
        if (cred.type === 'oauth') {
          return {
            ...base,
            expires: cred.expires,
            email: cred.email,
            hasRefresh: !!cred.refresh,
          };
        }
        return base;
      })
    : [];

  // Check env vars
  const envVars = getProviderEnvVars();
  const envProviders: string[] = [];
  for (const [provider, vars] of Object.entries(envVars)) {
    if (vars.some((v) => !!process.env[v])) {
      envProviders.push(provider);
    }
  }

  // Check OpenClaw store
  const openclawStore = await loadAuthProfileStore(getOpenClawStorePath());
  const openclawProviders = openclawStore
    ? [...new Set(Object.values(openclawStore.profiles).map((c) => c.provider))]
    : [];

  return { profiles, envProviders, openclawProviders };
}

export async function llmAuthAdd(params: LLMAuthAddParams): Promise<LLMAuthAddResult> {
  const profileId = params.profileId ?? `${params.provider}:default`;

  let credential: AuthProfileCredential;
  if (params.type === 'api_key') {
    credential = { type: 'api_key', provider: params.provider, key: params.credential };
  } else {
    credential = { type: 'token', provider: params.provider, token: params.credential };
  }

  // Run under the shared store lock so a concurrent OAuth login / refresh /
  // import can't clobber this manual write (or vice versa).
  await withFarmslotStoreLock(async () => {
    const store = await ensureAuthStoreFile(getFarmslotStorePath());
    upsertAuthProfile(store, profileId, credential);
    await saveAuthProfileStore(store, getFarmslotStorePath());
  });

  return { profileId };
}

export async function llmAuthRemove(params: LLMAuthRemoveParams): Promise<LLMAuthRemoveResult> {
  // Run under the shared store lock so a concurrent OAuth refresh / login /
  // import doesn't write back a deleted profile from a stale snapshot.
  return withFarmslotStoreLock(async () => {
    const store = await loadAuthProfileStore(getFarmslotStorePath());
    if (!store) return { ok: false };
    const removed = removeAuthProfile(store, params.profileId);
    if (removed) {
      await saveAuthProfileStore(store, getFarmslotStorePath());
    }
    return { ok: removed };
  });
}

export async function llmAuthTest(params: LLMAuthTestParams): Promise<LLMAuthTestResult> {
  const provider = params.provider ?? 'anthropic';
  const model = params.model ?? 'haiku';

  try {
    const result = await callLLM({
      provider,
      model,
      userPrompt: 'Reply with exactly: OK',
      maxTokens: 16,
    });

    return {
      ok: true,
      provider,
      model,
      source: (await resolveAuth(provider))?.source ?? 'cli',
      responsePreview: result.text.slice(0, 50),
      usage: result.usage,
    };
  } catch (err) {
    return {
      ok: false,
      provider,
      model,
      error: (err as Error).message,
    };
  }
}

export async function llmAuthImport(params?: LLMAuthImportParams): Promise<LLMAuthImportResult> {
  const source = params?.source ?? 'local';
  const overwrite = params?.overwrite ?? false;

  let openclawStore;
  if (source === 'remote') {
    if (!params?.host || !params?.sshUser) {
      throw new Error('Remote import requires host and sshUser');
    }
    const { importRemoteOpenClaw } = await import('../llm/auth-resolve.js');
    openclawStore = await importRemoteOpenClaw(params.host, params.sshUser);
  } else {
    openclawStore = await loadAuthProfileStore(getOpenClawStorePath());
  }

  if (!openclawStore) {
    return { imported: 0, profiles: [], skippedExisting: [], overwritten: [] };
  }

  return withFarmslotStoreLock(async () => {
    const farmslotStore = await ensureAuthStoreFile(getFarmslotStorePath());
    const imported: string[] = [];
    const overwritten: string[] = [];
    const skippedExisting: string[] = [];

    for (const [profileId, credential] of Object.entries(openclawStore!.profiles)) {
      if (
        credential.type !== 'api_key' &&
        credential.type !== 'token' &&
        credential.type !== 'oauth'
      )
        continue;
      const exists = profileId in farmslotStore.profiles;
      if (exists && !overwrite) {
        skippedExisting.push(profileId);
        continue;
      }
      upsertAuthProfile(farmslotStore, profileId, credential);
      if (exists) overwritten.push(profileId);
      else imported.push(profileId);
    }

    if (imported.length > 0 || overwritten.length > 0) {
      await saveAuthProfileStore(farmslotStore, getFarmslotStorePath());
    }

    return {
      imported: imported.length + overwritten.length,
      profiles: [...imported, ...overwritten],
      skippedExisting,
      overwritten,
    };
  });
}

export async function llmAuthRefresh(params?: LLMAuthRefreshParams): Promise<LLMAuthRefreshResult> {
  const filter = params?.profileId ? (id: string) => id === params.profileId : undefined;
  const outcomes = await refreshFarmslotProfiles(filter);
  return { outcomes };
}

export async function llmAuthLogin(
  params: LLMAuthLoginParams,
  emit: Emit,
): Promise<LLMAuthLoginResult> {
  const handlerLoader = OAUTH_LOGIN_HANDLERS[params.provider];
  if (!handlerLoader) {
    return { ok: false, error: `OAuth login not implemented for provider: ${params.provider}` };
  }
  const loginFn = await handlerLoader();

  const emitProgress = (progress: LLMAuthLoginProgress) => {
    emit(Events.LLM_AUTH_LOGIN_PROGRESS, progress);
  };

  // Cap the caller's wait. pi-ai ≥0.82 accepts an AbortSignal on the login
  // interaction, so the timeout now also cancels the underlying flow — the
  // local callback server releases port 1455 instead of holding it until the
  // gateway exits (the pre-0.82 failure mode this comment used to document).
  const loginAbort = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      loginAbort.abort();
      reject(
        new Error(
          `OAuth login timed out after ${OAUTH_LOGIN_TIMEOUT_MS}ms. ` +
            `The login flow was aborted; retry when ready.`,
        ),
      );
    }, OAUTH_LOGIN_TIMEOUT_MS);
  });

  try {
    const credentials = await Promise.race([
      loginFn({
        signal: loginAbort.signal,
        notify: (event) => {
          if (event.type === 'auth_url') {
            emitProgress({
              provider: params.provider,
              url: event.url,
              message: event.instructions,
            });
          } else if (event.type === 'device_code') {
            emitProgress({
              provider: params.provider,
              url: event.verificationUri,
              message: `Enter code ${event.userCode} at ${event.verificationUri}`,
            });
          } else if (event.type === 'info' || event.type === 'progress') {
            emitProgress({ provider: params.provider, message: event.message });
          }
        },
        // The browser-callback flow is the only OAuth completion path the
        // gateway supports today. pi-ai falls through to prompt() when the
        // local callback server can't bind to localhost:1455 OR when the
        // browser can't reach it (corporate proxy / remote-only login). We
        // don't have a UI affordance to accept a pasted code yet (no
        // bidirectional code-input RPC), so failing fast with a clear error
        // is more honest than emitting a manualPrompt event that never gets
        // a response — the alternative is the user staring at a hung dialog
        // until OAUTH_LOGIN_TIMEOUT_MS. Surface the manualPrompt event for
        // observability (logs / future UI) but reject the promise immediately
        // so pi-ai unwinds and the caller sees a useful error.
        // TODO: when the UI grows a `llm.auth.login.complete-manual` RPC,
        // resolve prompt() from it and unwire this fail-fast.
        prompt: (prompt) => {
          emitProgress({
            provider: params.provider,
            manualPrompt: {
              message: prompt.message,
              placeholder: 'placeholder' in prompt ? prompt.placeholder : undefined,
            },
          });
          return Promise.reject(
            new Error(
              'OAuth manual-paste fallback is not supported by the gateway. ' +
                'The local callback server could not bind localhost:1455 or your ' +
                'browser cannot reach it. Try logging in on a machine where the ' +
                'browser can hit http://localhost:1455, or use the codex CLI directly.',
            ),
          );
        },
      }),
      timeoutPromise,
    ]);

    const email = (credentials as { email?: string }).email;
    const profileId =
      params.profileId ?? (email ? `${params.provider}:${email}` : `${params.provider}:default`);
    const stored: OAuthCredential = {
      type: 'oauth',
      provider: params.provider,
      access: credentials.access,
      refresh: credentials.refresh,
      expires: credentials.expires,
      email,
    };

    await withFarmslotStoreLock(async () => {
      const store = await ensureAuthStoreFile(getFarmslotStorePath());
      upsertAuthProfile(store, profileId, stored);
      await saveAuthProfileStore(store, getFarmslotStorePath());
    });

    return { ok: true, profileId, email };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}
