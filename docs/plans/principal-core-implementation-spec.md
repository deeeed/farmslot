# Principal Core Implementation Spec

**Status:** proposed implementation spec
**Supports:** [ADR-051](../adr/051-principal-and-credential-model.md), [ADR-036](../adr/036-cli-gateway-profiles.md), [ADR-046](../adr/046-mandatory-local-node.md)

## Summary

This spec derives the **principal core** from ADR-051: the identity and credential types, the
credential store with its two coordination mechanisms, secret handling, principal resolution with
freshness, and session invalidation. It is the foundation every other part of ADR-051 compiles
against.

It deliberately builds **no authorization decisions**. Nothing here answers "may this principal call
this method". It answers only "which principal is this, and is that answer still current". The
authorization check, the operator allowlist, the conformance gate, the `principal.*`/`credential.*`
methods, node-subject enforcement, pairing changes, and work-item provenance are separate work; see
[Boundaries](#boundaries).

The store is scoped to one `FARMSLOT_HOME` while gateways are per-root and per-port, and that
asymmetry shapes three designs below: short-lived write locking, additive-only environment
reconciliation, and change-based freshness. Each is noted where it applies.

Where this spec and ADR-051 differ, the ADR governs.

## ADR sections implemented

| ADR section                                        | What this spec derives                                                             |
| -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| §1 Principals, subjects, and role bindings         | `Principal`, `PrincipalSubject`, `Role`, `RoleBinding`, `RoleScope`                  |
| §1 Virtual principals                              | `local-admin` and `local-node`; the reserved-id rule for all virtual principals      |
| §2 One identity domain per `FARMSLOT_HOME`         | Every store-adjacent path resolving through `farmslotHome()`                          |
| §2 Credentials and storage                         | `CredentialRecord`, `StoredSecret`, `CredentialStore`, `schemaVersion`               |
| §2 Store (permissions, atomicity, write exclusion) | The store module, `credentials.lock`, and the fail-closed load contract              |
| §2 Secret handling                                 | Entropy, wire format, the boot-secret path, `scrypt-v1`, constant-time comparison    |
| §2 Presenting a credential over the wire           | Store resolution replacing the single configured-value comparison                    |
| §2 Revocation and invalidation 1-3                 | `AuthenticationRef`, live lookup, session invalidation, verification cache, freshness |
| §3 Activation latch (`activatedAt`)                | The stored latch and the writes that set it                                          |
| §3 Two write mechanisms                            | `credentials.lock` for atomicity; the gateway presence marker for quiescence         |
| §3 Last-admin invariant                            | A running gateway's store writer refusal, evaluated against freshly read state       |
| §3 Legacy environment auth                         | Additive-only reconciliation to an `env-migrated` admin credential                   |
| §7 Writer-side revoke primitives                   | Credential and role revocation on the writer, per §7's boundary note                 |

Not implemented here, though the sections are adjacent: §2 invariant 4 (outbound filtering), §4, §5,
§6, and the rest of §7.

## Types

### Identity — `packages/protocol/src/rpc/principal.ts` (new)

Identity types live in the protocol package because §7 already fixes them as wire types:
`PrincipalListResult` carries `Principal[]` and `SelfPrincipalSummary` carries `RoleBinding[]`.
Placing them anywhere else would force a move when §7 lands.

```ts
interface Principal {
  id: string;
  subject: PrincipalSubject;
  roles: RoleBinding[];
}

type PrincipalSubject =
  | { type: 'person'; displayName: string }
  | { type: 'service'; displayName: string }
  | { type: 'node'; displayName: string; machine: string };

interface RoleBinding {
  role: Role;
  scope: RoleScope;
}

type Role = 'admin' | 'operator';
type RoleScope = { kind: 'global' };
```

Export from `packages/protocol/src/rpc/index.ts` alongside the existing `rpc/auth.js` export.

Rules that bind every consumer:

- `roles: []` is legal and authorizes nothing. No code path may read absence or emptiness as
  permission.
- `RoleScope` is a discriminated union. There is no absent-means-global rule, and no code may treat a
  missing scope as global.
- `machine` is required inside the `node` variant.

### Credentials and store — `services/gateway/src/security/credential-store.ts` (new)

These are gateway-internal. §7 states that `CredentialSummary` is the only credential shape that
leaves the gateway, so `CredentialRecord`, `StoredSecret`, and `CredentialStore` are not exported
from the protocol package.

```ts
interface CredentialRecord {
  id: string;
  principalId: string;
  displayName: string;
  secret: StoredSecret;
  origin: 'issued' | 'paired' | 'env-migrated';
  createdAt: string;
  revokedAt: string | null;
}

interface StoredSecret {
  scheme: 'scrypt-v1';
  salt: string;   // base64
  hash: string;   // base64
}

interface CredentialStore {
  schemaVersion: 1;
  activatedAt: string | null;
  principals: Principal[];
  credentials: CredentialRecord[];
}
```

Every field is required. `revokedAt === null` means active; revocation writes a tombstone and never
deletes the record, so a re-used id cannot resurrect access. `createdAt` is the rotation-age signal.
Timestamps are **ISO-8601 UTC** strings — a ruled choice, because the store is read by whichever
deployment in the domain opens it next.

### Session reference — `packages/protocol/src/rpc/principal.ts`

```ts
/** Opaque to the session: how this session authenticated, never what it may do. */
type AuthenticationRef = { kind: 'credential'; credentialId: string };
```

One variant in this node. The union exists so later resolution strategies are additive.

## Scope: one identity domain per `FARMSLOT_HOME`

§2 scopes everything in this node to one `FARMSLOT_HOME`, not to one machine. This is an
implementation rule before it is a wording preference: **every path below resolves through
`farmslotHome(env)` (`packages/protocol/src/node/farmslot-home.ts:11-15`), and nothing hard-codes
`~/.farmslot` or reasons about "the machine".** That helper exists so a custom `FARMSLOT_HOME` "can
never half-apply", and it is imported by both the CLI and the gateway for that reason. The default is
`~/.farmslot`, so the domain is machine-wide by default rather than by design.

Four things live in that directory and therefore share one scope by construction, unable to disagree
about which domain they protect: the credential store, the `activatedAt` latch inside it,
`credentials.lock`, and the gateway presence marker. Every rule below inherits that premise rather
than restating it.

**The operator-visible consequence runs both ways.** Deployments sharing a `FARMSLOT_HOME` share one
identity domain — the same principals, the same activation state. A deployment that wants its own
principals and its own solo-mode lifecycle sets its own `FARMSLOT_HOME`; that is the supported
separation mechanism and it already exists.

## Coordination: two mechanisms, two questions

§2 and §3 place two distinct mechanisms on the store. They answer different questions and neither
substitutes for the other. Both live in `FARMSLOT_HOME` because the store does, and because the
gateway singleton lock cannot serve either: `acquireGatewaySingletonLock()` writes
`<farmslotRoot>/.runs/gateway-<PORT>.pid` (`services/gateway/src/index.ts:100-144`), scoped per root
*and* per port, while `credentials.json` is shared across all of them.

### New: `services/gateway/src/security/credential-store-lock.ts` — write exclusion

`credentials.lock` beside the store. **Exclusive but short-lived: held for the duration of a single
read-modify-write and released.** Every writer takes it — any running gateway, and the offline CLI.
A gateway never holds it while merely running, so the per-root, per-port gateways the design permits
do not exclude one another; concurrent writes serialize and running gateways do not contend.

The single entry point is a wrapper, so no caller can write outside the exclusion:

```ts
withCredentialStoreLock<T>(fn: (store: CredentialStore) => { next: CredentialStore; result: T }): T
```

It acquires the lock, **re-reads the store file from disk**, passes that fresh value to `fn`, writes
the returned store, releases, and returns the result. Re-reading inside the lock is load-bearing
rather than defensive: with several gateways writing, an in-memory projection may be stale by the
time the lock is granted, and the last-admin invariant would then be evaluated against a store that
no longer exists.

Acquisition copies `acquireGatewaySingletonLock()` (`index.ts:100-144`), the existing proven pattern:

- `openSync(lockPath, 'wx')` then write `process.pid` — the exclusive create is the atomic step.
- On `EEXIST`, read the recorded pid. A live pid (checked with `processIsAlive()`, `index.ts:90-98`,
  where `EPERM` still counts as alive) means the lock is genuinely held: retry briefly, then refuse.
  A dead or malformed pid means a stale lock: unlink and retry the exclusive create, so a crashed
  writer does not wedge the store.
- Release unlinks only when the recorded pid is still this process, matching `index.ts:109-113`.

Refusal names the holder:

```
Another Farmslot process is writing the credential store (pid <pid>).
Next: wait for it to finish, or stop that process and retry.
```

Because the lock is short-lived, contention is bounded by one whole-file write, so a brief retry
before refusing is the right behaviour rather than failing on first contact.

### New: `services/gateway/src/security/gateway-presence.ts` — quiescence

§3 requires that an offline operation additionally prove **no gateway is running in this identity
domain**. Gateways under a different `FARMSLOT_HOME` are a different domain and are irrelevant to
this check. This is a separate requirement with a different reason: a running gateway holds in-memory
state derived from the store, and while change-based freshness makes it converge on an external
write, requiring quiescence removes the window entirely for deliberately out-of-band operations. It
protects cache coherence, not write atomicity, which is why the store lock alone is insufficient.

The marker is held in **shared** mode by every running gateway for its lifetime and acquired
**exclusively** by an offline operation. Node's standard library has no advisory file locking, so
shared mode is represented as a directory of per-gateway entries under
`join(farmslotHome(env), 'gateways.live')`:

- **Register** — a gateway writes one entry at start recording `pid`, `farmslotRoot`, and `port`, and
  removes it on shutdown. All three fields are stored because §3's refusal names each running gateway
  by root and port.
- **Live set** — entries whose pid fails `processIsAlive()` are stale and are reclaimed on read, so a
  crashed gateway does not permanently block offline management.
- **Exclusive acquisition** — an offline operation succeeds only when the live set is empty. Because
  the directory sits beside the store, "empty" means no gateway running in this identity domain,
  which is exactly the set whose in-memory state the operation could invalidate.

Registration and deregistration happen **while holding `credentials.lock`**, and an offline operation
holds that same lock across its presence check and its read-modify-write. Without that, a gateway
starting between an offline operation's check and its write would defeat the check. This is the
minimum needed to make the two mechanisms correct together; the lock stays short-lived in both paths.

Refusal names what is running, per §3:

```
Cannot modify the credential store: 2 gateways are running
(/Users/…/farmslot on port 7789, /Users/…/other-root on port 8808).
Next: stop them, then re-run this command.
```

## What changes, file by file

### New: `services/gateway/src/security/credential-store.ts`

Owns the file, the in-memory projection, and the freshness check. Sits beside `auth.ts` in the
existing `security/` folder.

**Path.** `join(farmslotHome(env), 'credentials.json')`, using
`packages/protocol/src/node/farmslot-home.ts`. Same home directory as `gateways.json`
(`gateway-profiles.ts:29-31`).

**Load.** `loadCredentialStore(path)`:

- File absent → return the empty store `{ schemaVersion: 1, activatedAt: null, principals: [],
  credentials: [] }` without writing anything. No file exists until the first mutation. This matches
  `loadProfiles()` (`gateway-profiles.ts:33-54`), which returns `{ gateways: {} }` for an absent file.
- Parse failure, non-object shape, or a record failing structural validation → throw naming the file,
  as `loadProfiles` does at `gateway-profiles.ts:38-52`. The gateway does not start.
- `schemaVersion !== 1`, including absent → throw naming the file and the version found. The gateway
  does not start. This is the fail-closed rule of §2, not a migration hook.

Structural validation is per record and total: every field of `CredentialRecord`, `StoredSecret`, and
`Principal` is checked for presence and type, subject and scope discriminants are checked against
their known variants, and an unknown `StoredSecret.scheme` is a load failure. A partially valid store
is a rejected store — there is no "skip the bad record" path, because a silently truncated store is
exactly what §2 refuses to run on.

**Validation is not only structural: §1's node rule is checked at load.** A `node`-subject principal
holds `roles: []` and is authorized by its subject alone, so a stored node principal carrying any
role binding is a **load failure**, named like any other, and the gateway does not start. Accepting
it and ignoring the roles would be the wrong failure mode — a node record with an `admin` binding is
either corruption or tampering, and the store is the thing authorization reads. The same rule is
enforced on the way in by `createPrincipal`, so the load check is a backstop against records that did
not come through this writer rather than a duplicate of it.

**Save.** `saveCredentialStore(store, path)`, combining §2's permission and atomicity rules. It is
called only from inside `withCredentialStoreLock` and asserts the lock is held.

1. `mkdirSync(dirname(path), { recursive: true, mode: 0o700 })`
2. `writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 })` where `tmp` is
   `${path}.${process.pid}.tmp` — the same directory, so the rename is atomic. Naming follows
   `github-bindings-cache.ts:65-69`.
3. `chmodSync(tmp, 0o600)` — the write mode only applies on create and is subject to umask, which is
   why `gateway-profiles.ts:59-60` chmods explicitly. Doing it **before** the rename means the
   published file is never observable with wider permissions.
4. `renameSync(tmp, path)`

Every mutation is a whole-file write. There is no partial update path.

**In-memory projection and freshness.** The store is loaded at gateway start into a module-level
value, along with a **freshness stamp** taken from the file: `{ dev, ino, mtimeMs, size }`.

```ts
ensureFresh(): void   // stat the store; reload and invalidate when the stamp differs
```

`ensureFresh()` compares a `statSync` of the store path against the stamp and, on any difference,
reloads the store, clears the verification cache, and replaces the projection. An absent file where
one was present, or present where absent, counts as a difference. This is the "cheap freshness check
on store identity and modification metadata" §2 invariant 3 requires.

**Lazy freshness alone cannot satisfy invariant 2, so detection is also proactive.** `ensureFresh()`
runs on request-driven paths, and a subscription is a *push* stream: after an external writer revokes
a credential or changes a binding, the affected session may never make another request, so no
authorization decision ever occurs and its subscription keeps delivering. The gateway therefore also
**polls** the store on an interval, running the same `ensureFresh()` and, on a detected change,
invalidating sessions as described under Session invalidation.

**A poll rather than a watch, and the reason is this node's own write mechanism.** Every write lands
by `rename`, which replaces the file's inode. An `fs.watch` handle bound to the store path keeps
watching the *old* inode and stops seeing changes after the first external write — the failure would
be silent and would look exactly like "no writes happened". Watching the containing directory avoids
that but trades it for platform-inconsistent event delivery and coalescing, and `FARMSLOT_HOME` also
holds the lock and presence entries, so directory events are noisy in a way that has nothing to do
with the store. A `statSync` poll is one code path shared with the lazy check, has no inode-identity
problem because it re-stats the path each time, and bounds staleness deterministically.

**The interval is a security parameter, and the specified value is 2 seconds.** It is not a tuning
knob: the interval *is* the bound on how long a revoked credential's or demoted principal's
subscription may continue receiving push events, because on an otherwise idle session the poll is the
only thing that will ever notice. Raising it to five minutes would leave revoked authority receiving
events for five minutes. **Changing this value changes the invalidation guarantee, so it is a change
to the security contract and needs the same scrutiny as any other — not a configuration decision.**
This is the one number in this node where "documented default" would be the wrong framing, and it is
called out precisely because the verification cache's bound sits nearby and genuinely is tuning — the
two must not be read as the same kind of value.

**The window is inherent to detection by polling, not introduced here.** Any polled detector has one;
a watch-based mechanism would bound it by event-delivery latency instead, which is usually smaller
but — for the inode reason above — not reliably *present* after a rename. Choosing the poll accepts a
known, stated, testable bound over an unstated one that can silently become infinite.

**Invalidation is change-based, not authorship-based.** A gateway that invalidated only on its own
writes would keep serving revoked authority after any external write — another gateway's or an
offline operation's — because the store is shared across the identity domain. So the projection is invalidated on this
gateway's own writes *and* whenever `ensureFresh()` observes a change underneath it.

**Reads (used by resolution).** Each is called after `ensureFresh()` on the resolution paths below.

- `findCredential(credentialId): CredentialRecord | undefined`
- `findPrincipal(principalId): Principal | undefined`
- `isActivated(): boolean` — `activatedAt !== null`
- `activeAdminCredentialCount(store): number` — credentials with `revokedAt === null` whose
  `principalId` resolves to a principal holding a `{ role: 'admin', scope: { kind: 'global' } }`
  binding. A credential whose principal is missing does not count, matching the fail-closed rule. It
  takes the store explicitly because the writer evaluates it against freshly read state, not the
  projection.

**Writer.** A single `CredentialStoreWriter` owns every mutation, each one a `withCredentialStoreLock`
call. §7's boundary note places the revoke primitives in this node: the last-admin invariant lives on
the writer and must be provable before any handler can reach it.

- `createPrincipal(subject, roles): Principal` — refuses a reserved id, and refuses a `node` subject
  carrying any role (both below)
- `issueCredential(principalId, displayName, origin): { record, secret; adminGrant?: { record, secret } }`
  — latches `activatedAt` on the first issuance if it is not already set, and performs the dual mint
  below when that latch would otherwise leave no admin
- `revokeCredential(credentialId): CredentialRecord`
- `revokeRole(principalId, role, scope): Principal`

**Two invariants bracket activation, and both live on the writer.** §3 reaches "activated with no
active admin credential" two ways and closes both here.

**The dual mint closes the first way.** A *first* issuance that mints only a non-admin credential
would latch activation while leaving no admin, so an operator could authenticate and nobody could
manage the store. §3 calls the dual mint "a correctness requirement, not a convenience", so
`issueCredential` may not complete an activation-latching issuance that leaves
`activeAdminCredentialCount() === 0`: in the **same** atomic write it also creates an owner principal
with `{ role: 'admin', scope: { kind: 'global' } }` and a credential over it, and returns that second
secret as `adminGrant` so the caller can surface it. One write, so activation and its admin can never
half-apply. §3's carve-out is preserved exactly: this binds a running gateway's writer, and an
offline first issuance can still create a non-admin and nothing else — that is the one path by which
row four survives, and it is deliberate.

The caller-facing side of that flow — writing the owner credential into the active gateway profile
and printing the activation walkthrough — is CLI work in a later node. What this node owes is that
the secret exists, is returned exactly once, and is never recoverable afterwards.

**The last-admin invariant closes the second way.** `revokeCredential` and `revokeRole` compute
`activeAdminCredentialCount()` against the **prospective** store, derived from the copy read inside
the lock, and refuse when it would reach zero, with the teaching error of §3:

```
Refusing to revoke credential '<name>': it is the last active admin credential,
and removing it would leave this gateway with no way to issue or revoke anything.
Next: issue a replacement admin credential first, then revoke this one:
  farmslot credential issue --principal <principal> --name <new-name>
```

The invariant binds a running gateway's writer only. §3 states explicitly that it does not apply to
offline store editing, which is the recovery path.

Each successful mutation calls the invalidation hook below before returning.

### New: `services/gateway/src/security/credential-secret.ts`

- `generateCredentialSecret(): string` — `randomBytes(32).toString('base64url')`.
- `generateCredentialId(): string` — 128-bit random, hex-encoded: `randomBytes(16).toString('hex')`.
  §2 pins hex because the base64url secret alphabet contains `_` and would make the delimiter
  ambiguous; the width is a ruled choice.
- `formatCredentialWire(credentialId, secret): string` — `` `fs_${credentialId}_${secret}` ``.
- `parseCredentialWire(presented): { credentialId, secret } | null` — requires the `fs_` prefix, then
  splits at the **first** `_` after it. The remainder is the secret verbatim, so a base64url secret
  containing `_` parses correctly. Anything else returns `null`, which routes to the boot-secret path.
- `hashSecret(secret): StoredSecret` — `scheme: 'scrypt-v1'`, `salt` = 16 random bytes, `hash` =
  `scrypt(secret, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 67108864 })`. `maxmem` is set explicitly
  because `128 · N · r` is exactly 32 MiB and sits on Node's default boundary. Both fields are
  base64-encoded, as pinned in the `StoredSecret` comments.
- `verifySecret(presented, stored): boolean` — rejects an unrecognized `scheme` outright, then
  **validates the stored fields before deriving anything**: `salt` and `hash` must decode as base64,
  and the decoded `hash` must be exactly `dkLen` bytes. Any failure returns `false`. Only then does it
  derive a key from `presented` with the stored salt and the pinned parameters and compare with
  `timingSafeEqual`.

  **The length check is explicit, not structural.** `timingSafeEqual` *throws* on buffers of
  differing length rather than returning false, and `StoredSecret` fields are read from a file that
  can be corrupted or attacker-influenced — so treating `dkLen` as guaranteed by construction would
  turn a malformed record into an exception on the authentication path instead of a clean denial.
- `safeEqualSecret(actual, expected): boolean` — moved here unchanged from `auth.ts:271-281`. See the
  `auth.ts` entry below for why it survives.

There is no rehash-on-authentication path. §2 permits one, but only one scheme exists, so there is
nothing to upgrade to and the code would be unreachable.

### New: `services/gateway/src/security/verification-cache.ts`

§2 invariant 3: verification may be cached, authority may not. `authorizeHttpRequest()` authenticates
every `/api/file` and `/api/run-artifact` request (`auth.ts:216-235`) and the Companion loads images
through that path, so `scrypt` at N = 2^15 per request would be a visible regression.

The cache maps **a digest of the presented secret to a credential id, and nothing else**:

- **Key** — `createHash('sha256').update(presented).digest('base64')`. Fast relative to `scrypt` by
  orders of magnitude, and collision-resistant, so a wrong secret cannot key onto another
  credential's entry. Holding a digest of a 32-byte random secret in memory adds no exposure beyond
  holding the secret itself, which the process already does while verifying it.
- **Value** — the `credentialId` only. No principal, no roles, no record.
- **Population** — successful verifications only. A failed verification is not cached; the rate
  limiter (`auth.ts:57-95`) already bounds repeated wrong secrets, and caching negatives would add a
  second thing to invalidate for no gain.
- **Bound** — at most 256 entries with least-recently-used eviction. **This is a documented default,
  not a security property.** The population is the set of credentials in active use, which is small;
  the cap exists so a flood of distinct values cannot grow it, and eviction is never a correctness
  concern because a miss just re-derives. Tuning it changes only how often the KDF runs.
- **Invalidation** — cleared on this gateway's own writes and by `ensureFresh()` when the store has
  changed underneath it.

**The security properties are the other three, and they are not negotiable against cache policy**:
the cache is cleared on every store write, it is consulted only after `ensureFresh()`, and it never
caches authority — no principal, no roles, no record, only a credential id that must still be
resolved and revocation-checked on every use.

A cache hit **skips only the KDF**. Resolution still reads the credential record and its principal
from the live store, so a revoked credential or a changed binding takes effect on the next request no
matter what is cached.

### New: `services/gateway/src/security/principal-resolver.ts`

The single place that answers "who is this". **Every entry point calls `ensureFresh()` first.** §2
invariant 3 places that check before *any* authority resolution rather than only before credential
verification: an established session authenticates once and then resolves authority on each request
without re-verifying a secret, so a check sitting only in front of the cache would never run for it,
and another writer's revocation would never reach it.

```ts
type PrincipalResolution =
  | { ok: true; principal: Principal; authentication?: AuthenticationRef }
  | { ok: false; reason: 'no_credential' | 'revoked' | 'missing_principal' | 'secret_mismatch' };
```

**`resolveSecret(presented: string, transport: 'token' | 'password'): PrincipalResolution`** — the
authentication path. §2 states one rule with one stated exception, and the transport argument is what
keeps the exception from widening.

**Transport is part of the rule, not an implementation detail.** §2 puts a credential's secret in the
`token` field and says password mode stays legacy-only, reachable only through the env-configured
admin path of §3, with no credential ever issued in password mode. So:

- **`token`** resolves issued and paired credentials by their embedded id, and falls through to the
  boot-secret path for a non-prefixed value (an environment token).
- **`password`** resolves the boot-secret path **only**, and only when this gateway's boot secret came
  from `FARMSLOT_GATEWAY_PASSWORD`. A `fs_`-prefixed value presented as `password` is refused without
  any lookup — an issued credential must never authenticate through password transport.

**Transport validation precedes the cache, always.** The verification cache answers "is this secret
valid", never "may this secret arrive this way" — it is keyed by the secret alone and knows nothing
about transport, so consulting it first would let a credential verified once through `token`
authenticate thereafter through `password`. The step order below is therefore normative, and an
implementer may not reorder steps 2 and 3.

1. `ensureFresh()`.
2. **Transport validation, before any cache or store access.** A `fs_`-prefixed value presented with
   `transport === 'password'` is refused here and goes no further. So is any `password` presentation
   when this gateway's boot secret did not come from `FARMSLOT_GATEWAY_PASSWORD`, since password mode
   is reachable only through that env-configured path. Neither refusal consults the cache, and
   neither depends on whether the secret would otherwise have verified.
3. Consult the verification cache. A hit yields a credential id and skips to step 6.
4. `parseCredentialWire(presented)`. On a match — an issued or paired credential — look up that one
   credential id. A single record lookup, which is what the embedded id buys.
5. On no match, the presented value may be this gateway's environment secret. Compare it with
   `safeEqualSecret` against the **boot-time environment secret** held for the process lifetime, and
   resolve to the single credential reconciled at boot. No scan and no `scrypt` on this path, so no
   timing surface across records.
6. `revokedAt !== null` → `{ ok: false, reason: 'revoked' }`.
7. `principalId` resolving to no principal → `{ ok: false, reason: 'missing_principal' }`. §2:
   missing principal fails closed.
8. `verifySecret` failure → `{ ok: false, reason: 'secret_mismatch' }`. On success, populate the
   cache. Step 5 has already compared its own value and does not re-verify.
9. Success → the principal and `{ kind: 'credential', credentialId }`.

Steps 6 and 7 run on a cache hit as well as a miss, and on the boot-secret path as well as the
prefixed one. That ordering is the invariant: nothing skips transport validation, and nothing skips
the revocation and principal checks.

**The boot-secret path narrows deliberately.** `env-migrated` credentials accumulate across roots and
rotations under additive-only reconciliation, so "there is at most one" is not available as a bound.
Binding the path to this gateway's own configured secret bounds it structurally instead. The
consequence belongs in code comments and operator-facing docs: **an `env-migrated` credential is
presentable only to a gateway configured with that secret.** Other roots' migrated credentials remain
valid records in the store but are not authenticable through this gateway, which is correct rather
than unfortunate — the environment variable *is* that credential's presentation mechanism, and a
gateway never given it has no way to know it. A gateway with no environment secret resolves no
non-prefixed secret at all.

If the boot credential is revoked while the gateway runs, step 5 denies it on the next request like
any other; the boot mapping is a lookup shortcut, never an authority.

**`resolveSessionPrincipal(session): PrincipalResolution`** — the per-check path, called on every
authorization decision rather than once per session:

1. `ensureFresh()`.
2. Solo mode (below) and no cached ref → the virtual principal for the session's `clientKind`:
   `local-node` for `'node'`, `local-admin` otherwise. §3 makes that choice at session establishment
   from `clientKind`, not inside the check.
3. A cached `AuthenticationRef` → repeat steps 5 and 6 above against the live store. No secret and no
   KDF are involved; the reference is resolved, not the secret.
4. Neither → `{ ok: false, reason: 'no_credential' }`.

A cached role cannot outlive its record because there is no cached role, and a revocation written by
another gateway or by an offline operation reaches this session at step 1.

**Virtual principals** are constructed values with no stored record, exactly as §1's table specifies:

| id            | subject                                                       | roles                                            |
| ------------- | ------------------------------------------------------------- | ------------------------------------------------ |
| `local-admin` | `{ type: 'person', displayName: 'local' }`                    | `[{ role: 'admin', scope: { kind: 'global' } }]` |
| `local-node`  | `{ type: 'node', displayName: <machine>, machine: <machine> }` | `[]` — subject-authorized                        |

They carry real role bindings, so authorization code sees an ordinary `Principal` and has no
virtual-principal branch.

**Reserved ids are one rule, not a list of cases.** §1 reserves *every* virtual principal's id and
extends that to any virtual principal added later. The resolver therefore exports a single
`VIRTUAL_PRINCIPAL_IDS` constant, and `createPrincipal` refuses any id in it. The constant today is
`['local-admin', 'local-node', 'system']`. `system` appears even though this node never constructs it
— §5.5 owns that principal — precisely because the reservation is generic: adding the resolver later
must not be the moment the id becomes protected, since a stored principal shadowing `system` would
inherit admin over gateway-scheduled work. Adding a virtual principal in future means adding one
entry here and nothing else.

**Node subjects carry no roles, and the writer enforces it.** §1 states that a `node`-subject
principal has `roles: []` and is authorized by its subject alone; roles are meaningful only for
`person` and `service` subjects. `createPrincipal` therefore refuses a `node` subject with a
non-empty `roles` array rather than silently storing or dropping the bindings, and the loader rejects
such a record fail-closed. Both checks exist because they catch different things: the writer stops it
being created through this gateway, the loader stops it being honoured if it arrives any other way.
The virtual `local-node` already satisfies the rule with `roles: []`, so this adds no special case
for it.

**Solo mode** is derived, never stored:

```
soloMode = !store.activatedAt && bindIsLoopbackOnly && !trustProxyHeaders
```

`bindIsLoopbackOnly` and `trustProxyHeaders` are boot facts already available where
`assertGatewayBindAllowed` is called (`index.ts:201-205`); `activatedAt` is read through the fresh
projection, so a latch written by any writer takes effect here. No `AuthenticationRef` is cached for
a solo session.

**Activation is shared by the identity domain, and the implementation should expect that rather than
treat it as a fault.** `activatedAt` is stored, and the store is one per `FARMSLOT_HOME`, so issuing
a credential from one deployment latches activation for *every* deployment sharing that home: their
`local-admin` and `local-node` stop resolving, and their co-launched nodes need issued credentials
per §6. A gateway that was never given a secret and binds only to loopback can therefore leave solo
mode because a different deployment activated. That is shared domain, shared activation — the same
rule as shared principals, seen from the lifecycle side. **A deployment that needs its own solo-mode
lifecycle sets its own `FARMSLOT_HOME`**, which is the separation mechanism §2 already describes,
applied to activation rather than to identity.

### New: `services/gateway/src/security/env-credential-migration.ts`

Runs once at gateway start, after the store loads, before the server accepts connections. §3 makes
reconciliation **additive only**: one action, one prohibition, one report.

- **If the current environment secret has no active `env-migrated` credential, migrate it** — create
  one. Retain `{ secret, credentialId }` for the process lifetime as the boot mapping the
  non-prefixed resolution path uses.
- **Never revoke any credential on the basis of an environment value, in any case.** Not on rotation,
  not on removal, not on mismatch.
- **Report at boot any other active `env-migrated` credentials that do not match the current
  environment**, naming explicit revocation as the way to remove them.

**The reason is a limit on what the gateway can know**, and carrying it into the code comments keeps
the rule from reading as arbitrary. Deployments sharing an identity domain share one credential
store, while each loads its own `.env.local-auth`: `services/gateway/src/index.ts:173-188` reads it
from `resolve(farmslotRoot, name)`, and `ensureTokenAuthEnv()`
(`packages/cli/src/commands/up.ts:190-212`) mints a fresh `FARMSLOT_GATEWAY_TOKEN` into each root's
copy. That is how two deployments in one domain come to present different secrets, and it means **a
gateway cannot distinguish "the operator rotated this secret" from "this is a different deployment's
secret in the same domain"** — both present as a mismatch against the store. Inferring revocation
from an ambiguity the system cannot resolve would let one deployment silently disable another's
access, and it would thrash: migrate deployment A's secret, start B and revoke A's, return to A and
revoke B's, indefinitely.

Reconciliation therefore only ever adds, and revocation is always explicit — the tombstone-only model
§2 already establishes, applied to the one path tempted to deviate from it. There is consequently
**no ordering hazard to manage**: a rule that never revokes cannot pass through a zero-admin state.

**First migration**, when the current secret has no credential, creates a `service` principal with a
single `{ role: 'admin', scope: { kind: 'global' } }` binding, creates a credential over it with
`origin: 'env-migrated'` whose `secret` is `hashSecret(<env secret>)`, and sets `activatedAt` if
unset. The principal's display name is **`legacy-env`**, a ruled choice satisfying §1's only
constraint that it not collide with `system`. The environment secret keeps authenticating because it
*is* that credential.

This is an issuance, so the dual-mint invariant applies to it like any other: migrating an
environment secret creates an admin-bound principal, so a first migration cannot latch activation
without an admin. That falls out rather than needing a special case — the migrated principal already
carries `{ role: 'admin', scope: { kind: 'global' } }`.

The boot report uses §3's text, because the surprise would otherwise run in the dangerous direction —
an operator who changes or unsets the variable expecting access to follow:

```
FARMSLOT_GATEWAY_TOKEN does not match any active credential; migrated it as a new one.
1 other active env-migrated credential does not match this environment — changing or
unsetting the variable does not remove access.
Next: to remove it, run
  farmslot credential revoke <id>
or stop every gateway and revoke offline.
```

Reconciliation is a single `withCredentialStoreLock` call, so principal and credential cannot
half-apply — which is why §2 keeps identity and credentials in one file.

### Changed: `services/gateway/src/security/auth.ts`

- `GatewayAuthSession` (`:16-21`) gains `authentication?: AuthenticationRef`. The existing
  `authenticated`, `clientKind`, `authMode`, and `authenticatedAt` fields stay: they record transport
  and telemetry, not authority.
- `GatewayAuthResult` (`:28-34`) gains `authentication?: AuthenticationRef` and
  `principal?: Principal`, so the caller can stamp the session and report the resolution without a
  second lookup.
- `authenticateGatewayClient` (`:142-188`) keeps its signature, its loopback rate-limit exemption
  (`:148-162`), and its failure reasons. Its comparison body changes: instead of comparing the
  presented value against `auth.token`/`auth.password`, it calls `resolveSecret` **with the transport
  the value arrived on** — `connectParams.token` as `'token'`, and `connectParams.password` as
  `'password'`. It keeps the existing branch order, trying `token` first, so it never launders a
  prefixed credential through the password branch. Failure records a rate-limit failure and returns
  `{ ok: false, reason: 'credential_mismatch' }` — a resolution failure never distinguishes "no such
  credential id" from "wrong secret" on the wire. Solo mode returns `{ ok: true, mode: 'none' }` with
  no ref, as it does today for `auth.mode === 'none'` (`:164-167`).
- `getHttpCredential` (`:300-315`) changes its return type from `string | undefined` to
  `{ value: string; transport: 'token' | 'password' } | undefined`. It already knows which scheme it
  matched; today it discards that and returns a bare string, which is what forces the caller to guess.
- `authorizeHttpRequest` (`:222-231`) **sets exactly one of `token` and `password`, never both.**
  Today it copies one extracted value into both fields, which launders an HTTP Basic credential into
  the token branch and defeats the rule above. Each scheme maps to exactly one transport:

  | HTTP scheme                                          | Transport  | Consequence                                            |
  | ---------------------------------------------------- | ---------- | ------------------------------------------------------ |
  | `Authorization: Bearer <secret>`                     | `token`    | issued, paired, and env-token credentials all resolve  |
  | Query parameter `?token=<secret>`                    | `token`    | the Companion's image path, which cannot send headers  |
  | Cookie `farmslot_gateway_credential`                 | `token`    | browser surfaces                                       |
  | `Authorization: Basic <user:secret>` (password part) | `password` | legacy-only — an issued credential presented as Basic is refused |

  The Basic row is the point of the table: it is the one HTTP scheme that maps to password transport,
  so it reaches only the env-configured admin path of §3 and never an issued credential. The other
  three are token transport, which is why the Companion's header-less image loads keep working
  unchanged.
- `requireAuthenticatedSession` (`:201-207`) replaces its `runtime.auth.mode === 'none'` short-circuit
  with a solo-mode check, and otherwise requires that `resolveSessionPrincipal` succeed. This is the
  freshness and live-lookup point on the request path.
- `safeEqualSecret` (`:271-281`) **survives and moves to `credential-secret.ts`**. Its callers in the
  token and password branches go away, but the boot-secret path needs exactly what it provides: the
  presented value and the configured secret may differ in length, and its padding branch keeps that
  comparison constant-time. `verifySecret` cannot serve there, because the boot-secret path compares
  two raw values rather than derived keys.
- `assertGatewayBindAllowed` (`:123-140`) is **unchanged**. Its rule — loopback without auth is fine,
  non-loopback without auth is refused with an error naming the fix — is the principle §3 extends, not
  a thing §3 replaces.
- `authorizeHttpRequest` (`:216-235`) keeps its shape and continues to delegate to
  `authenticateGatewayClient`, so HTTP credentials resolve against the store like WebSocket ones. Its
  `auth.mode === 'none'` fast path (`:221`) becomes a solo-mode check. The verification cache is what
  makes this path affordable; `ensureFresh()` is what keeps it correct.
- `resolveGatewayAuth`, the rate limiter, `resolveRequestIp`, `getHttpCredential`, and the failure
  responses are unchanged.

### Changed: `services/gateway/src/server/client-state.ts`

`ClientState` (`:37-46`) gains `authentication?: AuthenticationRef`. Nothing else about the session is
added — no principal, no roles, no cached authority.

### Changed: `services/gateway/src/server.ts`

- Connection setup (`:110-131`) currently marks every socket `authenticated: true` when
  `auth.mode === 'none'` and sends the privileged hello immediately (`:131`). The condition becomes
  solo mode. Behaviour is otherwise unchanged in this node; filtering the hello and broadcasts by the
  receiving principal is §2 invariant 4 and belongs to the authorization node.
- The `auth.connect` handler (`:501-543`) stamps `state.authentication` from the result alongside the
  fields it already sets at `:526-529`. The response payload at `:531-540` is unchanged — the §7
  `principal` summary is a later node.
- `requireAuthenticatedSession` at `:546` is unchanged at the call site; its semantics change inside
  `auth.ts` as described.
- A new exported `closeSessions(predicate)` walks `clients` and closes matching sockets with a
  WebSocket close, which tears down that session's subscriptions with it. The store writer calls it
  through a hook registered at start so that `security/` does not import the server.
- `broadcast` (`:624-634`) is **unchanged**. Per-principal outbound filtering is §2 invariant 4.
- The node frame guards (`:135-244`) are **unchanged**. They currently key on
  `auth.mode !== 'none'` and `clientKind !== 'node'`; requiring a `node`-subject principal is §6.

### Changed: `services/gateway/src/index.ts`

After the environment files load (`:173-188`) and before the auth runtime is built (`:201`): register
the gateway presence entry, load the store, run environment reconciliation, register the invalidation
hook, and start the freshness poll. Deregister the presence entry and stop the poll on shutdown
alongside the singleton lock release, including on the `SIGINT` and `SIGTERM` paths at `:164-171`.
The poll's timer is unref'd so it never holds the process open by itself.

A store-load failure is fatal and the process exits with the file named — §2 requires the gateway to
refuse to start rather than run on a store it cannot read.

### Deliberately unchanged

- `packages/cli/src/gateway-profiles.ts` — a credential is presented as the existing token mode, so
  `profileCredential()` (`:100-106`) already maps a stored secret onto the `auth.connect` shape.
- `packages/cli/src/commands/up.ts` — `ensureTokenAuthEnv()` (`:190-212`) keeps minting a per-root
  token. Additive-only reconciliation is what makes that safe against a domain-shared store.
- `packages/protocol/src/rpc/auth.ts` — `GatewayAuthConnectResult` (`:18-27`) and
  `PairingCreateParams` (`:29-33`) are §7 changes.
- `services/gateway/src/fleet/pairing.ts` — `pairingExchange` still returns the runtime secret. Minting
  a credential is §7.
- `services/node/src/index.ts` — the module-scope credential resolution at `:62` and
  `resolveGatewayCredential` at `:631` are the §6 node change.
- `packages/protocol/src/rpc/registry.ts` — no new methods in this node.

## Session invalidation

§2 invariant 2 requires that credential revocation, role-binding change, and the activation latch
each close or downgrade every affected open session, **including subscriptions**. All three
invalidate sessions in this node; none of them is deferred.

- **Credential revocation** → close every session whose `AuthenticationRef` names that credential id.
  The next frame from that client must re-authenticate, and it will fail.
- **Activation latch transition** → close every session. §3 states the consequence directly: open
  sessions must re-authenticate and their subscriptions are closed. Solo sessions in particular must
  drop, because `local-admin` and `local-node` stop resolving at that moment.
- **Role-binding change** → close every session whose resolved principal is the one whose bindings
  changed. Closing takes the invariant's *close* arm, which this node can satisfy completely: closing
  the socket tears down that session's subscriptions with it, so a principal cannot keep receiving a
  surface its new bindings no longer permit.

**Why closing rather than downgrading, stated so a later node does not read it as an oversight.** The
invariant offers close *or* downgrade. Downgrading — keeping the session open and narrowing what it
receives — is the better operator experience, but it requires per-principal outbound filtering of
`broadcast` and `sendHello`, which is §2 invariant 4 and needs the authorization check that does not
exist yet. Closing is the arm that is fully implementable now and is strictly the safer of the two,
so this node takes it. **The mechanism may later be refined from close to downgrade; the invariant
itself is satisfied here, not deferred.** Request-path authority is separately already correct
without any session action, because nothing caches a role and every decision re-resolves.

The writer calls the hook after the write succeeds, never before, so nothing is invalidated for a
mutation that did not land. The hook clears the verification cache and closes sessions per the rules
above.

### External writes invalidate too

**The three rules above are triggered by any observed change, not only by this gateway's writes.**
Confining them to local writes would not satisfy §2 invariant 2: the store is shared across the
identity domain, so another gateway or an offline operation can revoke a credential, change a
binding, or latch activation, and those sessions' subscriptions would keep delivering — a push stream
never reaches an authorization decision, so lazy freshness cannot reach it.

When the poll (or any `ensureFresh()`) observes a change, the gateway **diffs the reloaded store
against the projection it replaced** and derives the affected sets: credentials newly carrying a
`revokedAt`, principals whose `roles` differ, and an `activatedAt` that transitioned from null. It
then re-resolves every open session and applies exactly the same three rules — so an external
revocation closes the sessions holding that credential, an external role change closes that
principal's sessions, and an external activation closes all of them. A session whose resolution now
fails for any reason is closed regardless of which set it fell in, which is the fail-closed backstop.

**Closing is this node's work; filtering the content of a surviving session is not.** Downgrading —
keeping a session open and narrowing what it receives — needs per-principal outbound filtering
(§2 invariant 4). This node takes the invariant's *close* arm on every path, local and external
alike, which discharges "including subscriptions" completely because a closed socket has none.

## Test obligations

Stated as behaviours to prove.

**Fail-closed load**

- A store file containing invalid JSON causes the gateway to refuse to start, and the error names the
  file path.
- A store file whose `schemaVersion` is absent, or is any value other than `1`, causes the same
  refusal — not a silent upgrade and not a default.
- A store containing one structurally invalid record is rejected whole; no valid record from that file
  is loaded.

**Fail-closed resolution**

- A credential whose `principalId` matches no principal does not authenticate, even when the presented
  secret verifies against its hash.
- A credential with a non-null `revokedAt` does not authenticate.
- A presented secret whose embedded credential id does not exist does not authenticate, and the
  failure is indistinguishable on the wire from a wrong secret for an existing id.
- A `StoredSecret` with an unrecognized `scheme` never verifies.
- A stored `node`-subject principal carrying any role binding is a load failure that names the file,
  and the gateway does not start — the roles are not dropped and the record is not skipped.

**Credential transport**

- **An issued credential presented in the `password` field is refused**, and refused without a store
  lookup, even though the identical value in the `token` field authenticates. This is the property
  that keeps password mode legacy-only.
- The same holds for a paired credential, since both carry the `fs_` prefix.
- **Refusal survives a warm cache.** Authenticate the credential successfully through `token` so the
  verification cache holds it, then present the identical value through `password` and assert it is
  refused. This is the test that proves transport validation precedes the cache: a cache consulted
  first would return the credential id and authenticate it.
- An environment password secret still authenticates in the `password` field, so the legacy path is
  unbroken.
- An environment token secret authenticates in the `token` field.
- A gateway whose boot secret came from `FARMSLOT_GATEWAY_TOKEN` refuses that value presented as
  `password`, so the boot-secret path does not become transport-agnostic.

**HTTP transport mapping**

- Each scheme resolves on exactly the transport the table specifies: Bearer, query parameter, and
  cookie as `token`; Basic as `password`.
- **`authorizeHttpRequest` never populates both fields** — assert on the params it builds, since this
  is the laundering path and a behavioural test would pass while the bug is present.
- **An issued credential presented as HTTP Basic is refused**, while the same credential presented as
  Bearer authenticates.
- A Companion image request carrying `?token=<issued credential>` authenticates, so the header-less
  path keeps working.
- An environment password secret presented as Basic authenticates, so the legacy HTTP path is
  unbroken.

**Store file properties**

- After a save, the store file's mode is `0600` and its directory's is `0700`.
- Saving over an existing file whose mode was widened restores `0600`.
- A save that fails partway leaves the previous store readable and unchanged — assert by writing over
  a populated store with a failure injected between the temp write and the rename, then loading.
- No temp file remains in `FARMSLOT_HOME` after a successful save.
- No store file is created by loading, or by starting a gateway with no environment secret and no
  store.

**Write exclusion**

- `withCredentialStoreLock` releases the lock before returning, so no lock file remains after a write.
- Two concurrent read-modify-writes serialize and both mutations survive — the second must not clobber
  the first, which is what re-reading inside the lock buys.
- A lock whose recorded pid is dead is reclaimed rather than blocking forever.
- Release removes the lock file only when the recorded pid is the releasing process.
- `saveCredentialStore` refuses to write when the lock is not held.
- **A running gateway does not hold the lock**, so a second gateway on a different root or port starts
  successfully while the first is serving.

**Identity domain scoping**

- A custom `FARMSLOT_HOME` yields its own store, latch, `credentials.lock`, and presence directory:
  two gateways under different homes share nothing, and activating one leaves the other in solo mode.
- No path in this node is derived from `~/.farmslot` directly — assert by running the whole suite
  under a `FARMSLOT_HOME` override and confirming nothing is created in the default location.
- Two gateways under the same `FARMSLOT_HOME` see one another's credentials and one another's
  activation latch.

**Quiescence**

- An offline operation is refused while any gateway's presence entry in this domain is live, and the
  error names each running gateway by root and port.
- A gateway running under a *different* `FARMSLOT_HOME` does not block the operation.
- **The registration race is closed.** Interleave a gateway registering its presence entry with an
  offline operation performing its presence check and read-modify-write, and assert the two outcomes
  are the only ones reachable: either the offline operation completes and the gateway registers
  afterwards, or the gateway registers first and the offline operation is refused. A gateway must
  never register *between* the offline operation's check and its write. Drive it by holding each
  side at the point after acquiring `credentials.lock`, which is the interleaving the lock exists to
  close.
- An offline operation succeeds when no live entry exists.
- A presence entry whose pid is dead is reclaimed, so a crashed gateway does not permanently block
  offline management.
- A gateway registers its entry at start and removes it on shutdown, including on `SIGINT` and
  `SIGTERM`.
- Two gateways register simultaneously and both appear, proving shared mode.

**Secret handling**

Every pinned value in §2 gets an obligation, because a KDF parameter that drifts produces no visible
failure — the system keeps working, weaker.

- A generated secret decodes from base64url to **exactly 32 bytes**, and a generated `salt` decodes
  from base64 to **exactly 16 bytes**.
- Two credentials issued in succession produce different secrets and different salts.
- `hashSecret` calls `scrypt` with **`N=32768, r=8, p=1, dkLen=32` and `maxmem` = 64 MiB
  (67108864)** — assert on the arguments, not only on the output, since an output-only test passes
  with a `maxmem` that Node would have rejected on a different build.
- A `StoredSecret` produced by `hashSecret` verifies against a key derived independently with those
  same parameters, and fails against one derived with any of them altered.
- A generated credential id decodes from hex to **exactly 16 bytes** and contains no `_`, so the
  delimiter is unambiguous.
- `formatCredentialWire` output round-trips through `parseCredentialWire`, including when the secret
  contains `_` and `-`.
- A presented value without the `fs_` prefix does not resolve as an issued or paired credential.
- **Malformed input is rejected before `timingSafeEqual`, not by it.** A `StoredSecret` whose `salt`
  or `hash` is not valid base64, or whose `hash` decodes to a length other than `dkLen`, fails
  verification as a rejected record — it must not reach `timingSafeEqual`, which throws on mismatched
  buffer lengths rather than returning false. Assert that verification returns false and does not
  throw for each case.
- Verification compares derived keys with `timingSafeEqual` — assert that the comparison is reachable
  only after the explicit length validation above, since a timing assertion is not reliable in a
  test.
- **The raw boot-secret comparison is also constant-time by construction**: it is reachable only
  through `safeEqualSecret`, whose padding branch keeps a length mismatch constant-time. Assert the
  construction, and assert behaviourally that presented values both shorter and longer than the
  configured secret fail without throwing.

**Boot-secret path**

- A gateway configured with secret A authenticates A and resolves it to the credential reconciled at
  boot.
- **A gateway configured with secret A denies secret B**, even though B is an active `env-migrated`
  credential in the same store — proving the narrowing is structural rather than incidental.
- A gateway with no environment secret resolves no non-prefixed secret at all.
- No `scrypt` derivation occurs on the boot-secret path — assert by counting invocations.
- Revoking the boot credential while the gateway runs denies the environment secret on the next
  request.

**Freshness**

- A repeated successful authentication with the same secret derives the KDF once — assert by counting
  `scrypt` invocations across two identical requests.
- **An established session is denied after a revocation written by another writer.** Authenticate a
  session, then rewrite the store file directly — as a second gateway or an offline operation would,
  without invoking this gateway's invalidation hook — and assert the session's next authorization
  decision is denied, with no re-authentication and no local write. This is the test that proves the
  cross-writer gap is closed: freshness must gate *authority resolution*, not merely verification, or
  an established session would never observe the change.
- The same for a role-binding change written externally: the next resolution reports the new bindings.
- The same for an externally written activation latch: solo resolution stops.
- Revocation takes effect even when the verification is cached and the cache is not cleared — warm the
  cache, tombstone the credential in the projection without invoking the hook, and assert denial, so
  denial demonstrably comes from the record lookup rather than from cache clearing.
- A failed verification leaves no cache entry.
- The cache holds no more than its cap under a flood of distinct values, and eviction causes a
  re-derivation rather than a wrong answer.
- An unchanged store performs no reload — assert the freshness check does not re-parse when the stamp
  is identical.

**Activation dual mint**

- **Issuing a first non-admin credential into an unactivated store yields a reachable admin.** After
  the call, `activatedAt` is set, the requested operator credential is active, *and* an active admin
  credential exists over an owner principal — so the store is never activated with zero admins.
- The second secret is returned to the caller exactly once, as `adminGrant`, and is not recoverable
  from the store afterwards.
- Both credentials land in **one** write: an injected failure during the issuance leaves the store
  unactivated with neither credential, never activated with only the operator one.
- Issuing a first *admin* credential mints exactly one credential — the dual mint triggers on the
  absence of an admin, not on first issuance generally.
- Issuing into an already-activated store that has an active admin mints exactly one credential.
- The writer path is the one that carries this: an offline first issuance creating a non-admin alone
  is still permitted, which is §3's deliberate carve-out and the one way row four survives.

**Last-admin invariant**

- Revoking the only active admin credential is refused, and the error names the credential and gives
  the issue-first `Next:` line.
- Revoking one of two active admin credentials succeeds.
- Removing the last `admin` role binding from the principal behind the only active admin credential is
  refused by the same writer rule, proving the invariant lives on the writer and not in a handler.
- Revoking an operator credential while no admin credential is active succeeds — the invariant counts
  admin credentials, not credentials.
- An active credential whose principal is missing does not count toward the admin total.
- **The invariant is evaluated against freshly read state**: with a stale projection showing two admin
  credentials and the file showing one, the revocation is refused.

**Live lookup and session closing**

- A session authenticates, its credential is revoked through this gateway, and the session is closed.
- Revoking a credential closes the sessions holding it and leaves sessions on other credentials open.
- Latching activation through this gateway closes every open session, including solo sessions.
- **A role-binding change closes every session whose principal's bindings changed**, and leaves
  sessions belonging to other principals open. This covers both granting and revoking a binding — the
  invariant is about authority changing, not about it narrowing.
- **Closing a session on a role change tears down its subscriptions**, so no further event reaches
  that socket. Assert by subscribing, changing the principal's bindings, and confirming the
  subscription produces nothing more — this is the "including subscriptions" clause of §2 invariant 2
  being satisfied by the close arm.

**Cross-writer invalidation of push streams**

These are the obligations that prove lazy freshness is not the only mechanism. Each writes the store
file directly, as another gateway or an offline operation would, without invoking this gateway's
invalidation hook, and **the subscribed session makes no request at any point**.

- **An external role change closes an affected subscribed session.** Subscribe, rewrite the store so
  the session's principal holds different bindings, and assert the session is closed and its
  subscription stops delivering — without that session having issued a request. A request-driven
  check alone cannot pass this, which is the point.
- An external credential revocation closes the sessions holding that credential, and leaves sessions
  on other credentials subscribed.
- An external activation latch closes every session, including solo sessions that were never
  credentialed.
- An external write that changes nothing relevant — another principal's binding — leaves the
  subscribed session open and still delivering, so detection is not indiscriminate.
- **Invalidation happens within 2 seconds of the external write**, with no request occurring — assert
  against that literal bound, not against whatever the configured interval happens to be. Advance
  time rather than issuing a frame. Writing this as "within the poll interval" would make the test
  tautological: it would pass at any cadence, including one that leaves revoked authority subscribed
  for minutes. A change to the interval must therefore break this test, which is the point of
  pinning it.

**Environment reconciliation**

- First boot with `FARMSLOT_GATEWAY_TOKEN` set and no store file: a `service` principal with an
  `admin`/`global` binding exists, one credential with `origin: 'env-migrated'` exists, `activatedAt`
  is set, and the raw environment token still authenticates.
- The same holds for `FARMSLOT_GATEWAY_PASSWORD` presented in the `password` field.
- The migrated principal's display name is not `system`.
- Restarting with the same secret performs no write — the store file's contents are byte-identical.
- **Rotation adds and revokes nothing**: restarting with a changed secret leaves the previous
  `env-migrated` credential active and adds one for the new value.
- **Removal revokes nothing**: restarting with the variable unset leaves every `env-migrated`
  credential active, whatever the admin count.
- The boot report names each active `env-migrated` credential that does not match the current
  environment, and names explicit revocation as the way to remove it.
- Two roots reconciling in turn converge rather than thrash: after A, then B, then A again, every
  migrated credential from both is still active and no revocation has occurred.
- A stored profile written before migration (`authMode: 'token'`, the environment secret verbatim)
  still authenticates after migration, so existing deployments and paired Companions keep working.
- Revoking an `env-migrated` credential explicitly revokes only it.

**Solo mode and reserved ids**

- Never latched, loopback bind, no proxy trust: a session with no credential resolves to `local-admin`,
  and a session presenting `clientKind: 'node'` resolves to `local-node`.
- Once `activatedAt` is set, neither virtual principal resolves, and an uncredentialed session does not
  authenticate — revoking every credential does not restore solo mode.
- The writer refuses to create a stored principal whose id is any member of `VIRTUAL_PRINCIPAL_IDS`,
  including `system`, which this node never constructs.
- **The writer refuses a `node` subject carrying any role binding**, rather than storing it or
  silently dropping the roles — the mirror of the loader's fail-closed rejection, so the rule holds
  on both the way in and the way out.
- A `node` subject with `roles: []` is accepted, and the virtual `local-node` satisfies the same rule
  without a special case.

## Migration and compatibility

**First boot with an existing environment secret.** Covered above: the secret becomes a credential and
keeps working. Clients need no change — a credential is presented as the existing token mode,
`authMode` stays in the protocol contract, and stored profiles are already the right shape
(`gateway-profiles.ts:100-106`).

**First boot with no store at all and no environment secret.** Nothing is written. On a loopback bind
the gateway is in solo mode and `farmslot up` works unchanged, satisfying ADR-046 by resolving virtual
principals rather than by excepting them. On a non-loopback bind, `assertGatewayBindAllowed`
(`auth.ts:123-140`) refuses as it does today.

**A second deployment in the same identity domain.** Its gateway registers a presence entry,
reconciles its own `.env.local-auth` secret additively, and shares the store. Both gateways serve,
neither revokes the other's credential, and writes serialize on `credentials.lock`. They also share
principals and activation state; a deployment that wants neither sets its own `FARMSLOT_HOME`, and
then shares nothing — a separate store, latch, lock, and presence directory.

**An existing store.** Loaded and used. Only version `1` exists; anything else is a refusal to start,
which is what `schemaVersion` was added to buy.

**Downgrade.** A gateway built before this node ignores `credentials.json` entirely and reads the
environment secret directly, so rolling back is safe as long as the variable is still set. A store
containing issued credentials has no effect on an older binary — those credentials simply stop
working. This is a property of the design, not a supported procedure.

## Boundaries

What this node deliberately leaves to later work, and where the seam sits.

| Deferred to                | Seam this node leaves                                                                                                     |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Authorization (§5.1-5.3)   | `resolveSessionPrincipal` returns a `Principal` with real role bindings. No caller reads `roles` yet. The operator allowlist, default-deny, and the denial messages of §8 attach at `routeMethod()`. |
| Conformance gate (§5.4)    | Nothing here. The gate takes the registry plus the allowlist, neither of which this node touches.                          |
| Node subject (§6)          | The `node` subject variant exists with `machine` required. The node frame guards in `server.ts:135-244` still key on `clientKind`, and `auth.connect` does not yet reject `clientKind: 'node'` from a non-node principal. |
| Protocol surface (§7)      | `GatewayAuthConnectResult` gains no `principal` summary here, and `CredentialSummary`, the seven `principal.*`/`credential.*` methods, and `PairingCreateParams.authority` are not defined. The CLI plumbing in `gateway-auth.ts:13-17` and `commands/auth.ts:181-190` follows §7, not this node. |
| Pairing (§7)               | `pairingExchange` still returns the runtime secret. Minting an `origin: 'paired'` credential needs `PairingAuthority`.      |
| Provenance (§5.5)          | The `system` virtual principal is **not** constructed here — it is returned only for gateway-scheduled work, which does not exist yet. Its id is reserved regardless. `WorkOriginator` belongs with each work item's own store, not with this one. |
| Outbound filtering (§2.4)  | `broadcast` and `sendHello` are unchanged. Filtering them by the receiving session's principal needs the authorization check first. This is the *downgrade* refinement of §2 invariant 2 only — invalidation on role change is satisfied here by closing, not deferred. |
| Activation triggers (§3)   | This node latches `activatedAt` on first credential issuance and on environment migration. Latching on a non-loopback bind and on declared proxy trust is activation semantics beyond what the store needs, and lands with the work that owns the bind path. |
| Offline store operations (§3) | The store module, both coordination mechanisms, and the writer are all usable offline, and the presence marker is what makes offline operations refuse while any gateway in the domain runs. No CLI command calls them yet. |
| Node credential re-resolve (§6) | `services/node/src/index.ts:62` still resolves once at module load.                                                    |
| `farmslot doctor` (§3)     | Reporting which of §3's four states the gateway is in. This node emits the reconciliation boot report only.                |

## Divergences, rulings, and open questions

**No *implementation* question is open in this spec, and nothing here is assumed** — but the design is
not settled end to end, and the two levels must not be confused.

Every divergence raised against earlier revisions of ADR-051 was resolved in the ADR, and every
implementation choice the ADR does not pin has since been **ruled** by the owner and is recorded
below. That is the whole of what this spec claims.

**ADR-051 retains four open questions that belong to the gateway's owner rather than to
implementation**, and they remain outstanding. See its `## Open questions` section; they are
deliberately neither restated nor summarised here, because a paraphrase of a decision document drifts
the moment the original is edited — which is the failure this process exists to prevent. **An
implementer should read this spec as complete for its scope and should not read it as evidence that
the design above it is decided.**

The heading is kept and the three states below are kept distinct, so a reader can tell "considered
and resolved" from "ruled" from "never considered".

### Resolved divergences

Two consequences recorded against earlier revisions are closed rather than outstanding. The
**gateway-exclusivity** consequence is gone: two coordination mechanisms replace one, a running
gateway holds no write lock, and concurrent gateways coexist. The **shared-activation** consequence
is resolved as documented behaviour rather than a defect — the scope was never the machine, it is one
identity domain per `FARMSLOT_HOME`, and deployments sharing a home share principals and activation
by construction. It is described where activation is covered, with the existing remedy named: a
deployment needing its own solo-mode lifecycle sets its own `FARMSLOT_HOME`.

### Ruled choices

These are **decisions, not proposals**. The ADR does not pin them; the owner has, and an implementer
may not substitute an alternative without a further ruling.

- **Timestamps are ISO-8601 UTC.** `createdAt`, `revokedAt`, and `activatedAt` alike. Not local time
  and not an offset — a store is read by whichever deployment in the domain opens it next, and a
  local-time stamp would make rotation age wrong rather than merely inconsistent.
- **Credential ids are 128-bit random, hex-encoded** — `randomBytes(16).toString('hex')`, consistent
  with §2's hex-id rule and its reason: the base64url secret alphabet contains the `_` delimiter.
- **The freshness stamp is exactly `{ dev, ino, mtimeMs, size }`** from a `statSync` of the store
  path, with an absent-versus-present transition also counting as a change. All four fields are
  required: `mtimeMs` alone misses a same-millisecond rewrite, and `dev`/`ino` are what catch a
  replacement by rename — which is precisely how every write in this node lands. **An implementer
  must not substitute a weaker check**, such as mtime only or a content hash sampled on an interval.
- **The freshness poll interval is 2 seconds, and it is a security parameter, not a default.** It
  bounds how long a revoked credential's or demoted principal's subscription may keep receiving push
  events. Changing it changes the invalidation guarantee, so it is a change to the security contract;
  the obligation asserts the literal bound so that a change breaks a test rather than passing
  silently.
- **The verification cache is keyed by the SHA-256 digest of the presented secret**, stores only a
  credential id, and is bounded with eviction. **The bound — 256 entries, least-recently-used — is a
  documented default, not a security property**; tuning it changes only how often the KDF re-runs.
  **The security properties are that the cache is cleared on every store write, that it is consulted
  only after `ensureFresh()`, and that it never caches authority** — no principal, no roles, no
  record. Those three may not be traded away for any cache policy.
- **The migrated environment principal's display name is `legacy-env`**, satisfying §1's only
  constraint that it not collide with `system`.

### Fills that follow from the rulings

Recorded so they are confirmed rather than discovered, and because each is a place a reasonable
implementer could otherwise choose differently:

- **The presence marker is a directory of per-gateway entries**, `gateways.live` beside the store and
  therefore per identity domain, each recording pid, root, and port. Node's standard library has no
  advisory file locking, so shared mode is represented by presence rather than by a shared lock, and
  the per-entry fields are what let §3's refusal name each running gateway.
- **Presence registration and the offline presence check both hold `credentials.lock`.** Without
  that, a gateway starting between an offline operation's check and its write would defeat the check.
  Both paths keep the lock short-lived, and the interleaving has its own test obligation.
- **`credentials.lock` is the lock file's name**, ADR-aligned rather than proposed.
