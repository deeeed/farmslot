# ADR-014: LLM Provider Abstraction

**Status:** Accepted
**Date:** 2026-03-27
**Relates to:** [ADR-006](006-openclaw-reuse.md) (OpenClaw reuse), [ADR-013](013-gateway-mediated-orchestration.md) (gateway orchestration)

## Context

M11.4 introduced intelligence features (bug grading, task writing) that require LLM calls from the gateway. The initial implementation uses `claude -p` (CLI pipe mode) — functional but Claude-only.

OpenClaw solves this with a mature multi-provider abstraction:

- **`@earendil-works/pi-ai`** library routes calls to any provider (Anthropic, OpenAI, Google, Ollama, etc.) based on model API type
- **`auth-profiles.json`** stores credentials per-provider with three types: `api_key`, `token` (setup-token), `oauth`
- **`resolveApiKeyForProvider()`** cascading auth resolution: explicit profile → auth store → env vars → config
- **`complete(model, context, {apiKey})`** single function for all providers

Farmslot needs this abstraction because:

1. **Grading quality varies by model** — want to test different providers (Anthropic, OpenAI, local) without code changes
2. **Cost optimization** — route cheap tasks (grading) to haiku/GPT-4o-mini, expensive tasks to opus
3. **Subscription reuse** — OpenClaw setup-token auth works via CLI pipe, but direct API calls need the full auth stack
4. **Future: agent runner flexibility** — workers already support Claude and Codex; orchestrator intelligence should too

## Options Considered

### A. Claude CLI Pipe (current M11.4 implementation)

Gateway shells out to `claude -p --model <model>` for every LLM call.

**Pros:**

- Works today with zero dependencies
- Uses subscription auth automatically
- Mirrors OpenClaw's claude-max-api-proxy pattern

**Cons:**

- Claude-only — can't use OpenAI, Google, local models
- Process spawn overhead (~1-2s per call)
- No streaming support
- CLI may change flags between versions

### B. `@earendil-works/pi-ai` as Dependency

Add pi-ai library, share OpenClaw's auth-profiles store.

**Pros:**

- All providers supported out of the box (20+ via extensions)
- Shared credentials with OpenClaw (same auth-profiles.json)
- Streaming support, proper error handling, retries
- Battle-tested in OpenClaw production
- Single `complete()` call, same API for every provider

**Cons:**

- New dependency (~pi-ai)
- Need to read auth-profiles from OpenClaw's agent dir or create our own
- pi-ai evolves for OpenClaw's needs, not ours (ADR-006 concern)
- OAuth token refresh adds complexity

### C. Copy pi-ai's Anthropic Transport Only

Fork the Anthropic-specific HTTP code from pi-ai, support x-api-key + Bearer auth.

**Pros:**

- No external dependency
- Minimal code (~100 lines for Anthropic messages API)
- Can add OpenAI-compatible transport later (~50 more lines)

**Cons:**

- Maintaining HTTP client code ourselves
- No automatic provider discovery
- Auth resolution reinvented (env vars + config, no profiles)
- Miss out on pi-ai improvements

## Decision

**Option B — `@earendil-works/pi-ai` as dependency**, with a thin gateway wrapper.

ADR-006 chose "copy, don't depend" for infrastructure. But pi-ai is different:

- Infrastructure (WS server, protocol) is stable and rarely changes — copying makes sense
- LLM providers change constantly (new models, API versions, auth schemes) — a maintained library has clear value
- pi-ai is small and focused (not all of OpenClaw, just the LLM transport layer)
- Same author maintains both projects — version alignment is practical

### Architecture

```
services/gateway/src/llm.ts            ← thin wrapper
  ↓
@earendil-works/pi-ai            ← provider routing + HTTP transport
  ↓
auth-profiles.json             ← shared credential store (OpenClaw-compatible)
```

**`llm.ts`** exposes:

```typescript
interface LLMCallOptions {
  provider?: string; // default: "anthropic"
  model?: string; // default: from project config
  systemPrompt?: string;
  userPrompt: string;
  maxTokens?: number;
}

async function callLLM(opts: LLMCallOptions): Promise<string>;
```

**Auth resolution order:**

1. Project config `models.provider` + `models.api_key_env` (per-project override)
2. OpenClaw auth-profiles.json (shared credentials)
3. Environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.)
4. Fallback: `claude -p` CLI pipe (subscription auth, Claude-only)

**Credential sharing:** Read from `~/.openclaw/agents/<default>/auth-profiles.json`. Farmslot does NOT write to this file — OpenClaw owns it. If no OpenClaw install exists, fall back to env vars.

### Fallback Chain

```
callLLM({ model: "haiku" })
  ├─ Try pi-ai complete() with resolved auth
  ├─ If auth fails → try claude -p CLI pipe (subscription)
  └─ If CLI fails → throw (no silent degradation)
```

## Consequences

**Positive:**

- Any provider works: `callLLM({ provider: "openai", model: "gpt-4o-mini" })`
- Shared auth with OpenClaw — set up once, works everywhere
- Streaming available when needed (future: progress updates during grading)
- Cost tracking possible (pi-ai exposes token counts)

**Negative:**

- New dependency to manage (pi-ai)
- Auth-profiles path coupling with OpenClaw's directory structure
- Need to handle pi-ai version updates

**Migration:** Current `claude -p` calls become the fallback. `llm.ts` wrapper is a drop-in replacement — `intelligence.ts` changes from `callLLM(...)` CLI to `callLLM(...)` pi-ai with identical interface.

## Implementation (M11.7)

1. Add `@earendil-works/pi-ai` to gateway deps
2. Create `services/gateway/src/llm.ts` — thin wrapper with auth resolution + fallback
3. Create `services/gateway/src/llm-auth.ts` — read OpenClaw auth-profiles + env var fallback
4. Update `intelligence.ts` to use `callLLM()` instead of CLI pipe
5. Add `models` section to project.json for per-project model/provider config
6. Test with Anthropic (setup-token via auth-profiles) and OpenAI (API key via env)
