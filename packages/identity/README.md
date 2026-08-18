# @church/identity

Registration, credential verification, password policy, and lockout. Token issuance is
deliberately **not** here — that is CORE-014. This package answers one question: *are these
credentials good, and is this account usable.*

## The awkward part: authentication cannot be tenant-scoped

Every other table in this system is reached inside a tenant context. Login cannot be: the
church is not known until the user is found, and the user is found by email address.

Rather than weaken the policy on `app_user`, `verifyCredentials` uses the audited escape
hatch from `@church/tenancy`:

```ts
this.#db.unsafeCrossTenantTransaction(
  'authentication: the email lookup precedes any tenant context',
  ...
);
```

Everything after the lookup — the failure counter, the lock, the rehash — runs inside
`runWithTenant` for the church that was found. The hole is exactly one query wide, it is
named, and it is greppable. An isolation test asserts both halves: that the ordinary path
still cannot see across churches, and that this path deliberately can.

**One email is one account at one church.** The unique index on `lower(email)` is global,
because a per-church index would make "which church is this login for?" a question the
login form has to ask. Someone genuinely involved with two churches needs two accounts
until SSO lands (V3). Worth revisiting then.

## Choices that look odd until you know why

**scrypt, not Argon2id.** OWASP names Argon2id first and scrypt as an accepted
alternative. scrypt is memory-hard and ships in `node:crypto`, so no native build is needed
in every environment that runs the tests. Parameters (N=2^16, r=8, p=2 — about 64 MiB) are
stored with each hash, so raising the cost later does not invalidate anyone's credentials:
old hashes verify under their own parameters and are upgraded on next successful login.

**Failed logins and unknown addresses return the same result.** A distinguishable response
turns the login form into a user directory. `dummyVerify` burns comparable work when no
account exists, because a 1 ms "no such user" against a 100 ms real check leaks the same
thing through latency. A test asserts both paths land within the same order of magnitude.

**Duplicate registration returns `unavailable`, never "already registered".** The email
index is global, so a raw unique violation would confirm an address exists *anywhere* on
the platform — including at another church. Tested in both the same-church and
cross-church cases.

**Locks expire, and escalate.** 5 failures locks for 5 minutes, doubling per further
breach, capped at an hour. A permanent lock would let anyone who knows a volunteer's email
keep them out — turning a guessing attempt into a denial of service against a real person.

**The breach check fails open by default.** A Have I Been Pwned outage must not stop a
church registering volunteers on a Sunday morning. The result reports
`breachCheckSkipped`, so the caller can record that the check did not run; deployments
that would rather fail closed can set `onUnavailable: 'deny'`. Only the first five
characters of the SHA-1 ever leave the process (k-anonymity), asserted by a test using a
distinctive passphrase.

**Length over composition.** Minimum 12 characters, no "one uppercase, one symbol" rule.
Composition rules push people toward `Password1!` and away from passphrases. What is
screened instead: length, breach membership, similarity to the account's own email, and
trivially repetitive input.

## Sessions (CORE-014)

`SessionService` turns verified credentials into a token pair and takes it away again.

**Access tokens are stateless and short-lived (15 minutes).** Verifying one is a signature
check, not a database round trip, which is what makes per-request authentication cheap. The
price is that an access token cannot be revoked mid-life: after "log out all devices", an
already-issued access token stays valid until it expires. A test asserts that window exists
rather than pretending otherwise — 15 minutes *is* the exposure, and it is why the TTL is
short. Anything needing instant revocation must check state server-side.

**The algorithm is pinned on verification.** Without that, a token claiming `alg: none`
is accepted as valid; there is a test that forges exactly that.

**Signing keys are a ring, not a value.** The active key signs; previously active keys stay
in `accepted` until every token they signed has expired. Without the overlap, rotating a key
logs out everyone holding a valid token.

**Refresh tokens are opaque, hashed, and rotate on every use.** SHA-256 rather than scrypt,
deliberately: these are 256 bits of uniform randomness, not user-chosen passwords, so a slow
hash buys nothing and would add ~100 ms to every refresh.

**Reuse of a rotated token revokes the entire family.** Rotation makes a token valid exactly
once, so a second presentation is a replay or a stolen copy — indistinguishable from the
server's side. Killing the family logs out both the attacker and the legitimate holder.
That is the right trade: the alternative leaves a thief with a live session and the user
with no signal anything happened. A deliberate logout does *not* escalate this way, because
it is not evidence of theft.

**A family per login.** One device's compromise or logout does not touch the others; a test
covers both directions.

## What is missing on purpose

- **MFA** — CORE-015.
- **Self-service unlock via a verified channel** — needs the Communications module
  (CORE-030). Until then a locked account waits out the timer or is cleared by an admin.
- **Audit records** — CORE-021. Login failures and lockouts are exactly what that log is
  for, and the call sites are marked.
