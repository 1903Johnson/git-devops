# SEC-REVIEW — adversarial security review of `main`

**Assignee: Codex. Standing task — it does not close.**

This is a task file, not a GitHub issue. There is no issue number to look up; the
coordinates below are everything needed to start.

| | |
|---|---|
| Repository | `1903Johnson/git-devops` |
| Branch to review | `main` — the merged state, never an open pull request |
| Deliverable | a written report, back to Claude. No commits, no branches, no pull requests |
| Cadence | after each batch of merges, or whenever Claude asks for a pass |

## Before starting: check you are actually on current `main`

A previous pass was written against a checkout fourteen merges stale, which made the
findings unusable — code the report described had already been replaced. Confirm the
checkout first:

```bash
git fetch origin main && git log --oneline -1 origin/main
```

If that fails — the sandbox has previously returned `CONNECT tunnel failed, response 403`
on `git ls-remote` — **stop and report the blocker**. A review of a stale tree is worse
than no review, because it reads as a clearance. Say which commit you could see and that
you could not fetch.

Record the commit you reviewed at the top of the report. Every finding is anchored to it.

## The brief

Everything below the line is the prompt. Read it as written; it is the whole task.

---

```text
ROLE: adversarial security reviewer for a multi-tenant church management platform.

You are not helping to write this system. You are trying to break it, and your output is
judged on what you find, not on how much of the code you approve of. A pass that concludes
"no issues found" is a pass that failed, unless you can show what you tried.

Work only from the merged state of `main`. Do not open pull requests, do not push branches,
and do not fix anything — report it. Claude fixes.

WHAT THIS SYSTEM IS
A multi-tenant SaaS for churches. One database, one schema, many tenants ("churches"),
separated by PostgreSQL row-level security keyed on `church_id`. It holds children's
attendance and medical notes, pastoral care records, and payment data. The worst realistic
outcome is one church reading another church's children's records; the second worst is a
custody boundary being crossed at a check-in desk.

READ FIRST
- `docs/01-architecture.md` — tenancy model, request lifecycle, entitlement vs enablement
- `docs/02-module-system.md` — optional modules, purge, and §5 on guardian authorisation
- `AGENTS.md` §3 — the boundary rules CI enforces
- Every package README. They state the invariants each package claims to hold; your job
  includes checking whether the code actually holds them.

WHERE TO ATTACK, IN ORDER OF WHAT IT WOULD COST US

1. Tenant isolation. Every table carrying `church_id` should be unreadable and unwritable
   across tenants. Look for: a query that does not run inside `runWithTenant`; a repository
   that builds its own SQL; RLS enabled without FORCE; a policy with USING but no
   WITH CHECK; anything reachable as a superuser or table owner where RLS silently does not
   apply; foreign keys that do not carry `church_id`, since FK checks run as the table
   owner and ignore RLS entirely.

2. Authentication and session handling. `packages/identity` and `apps/api/src/auth`.
   Refresh-token rotation and family revocation, the MFA challenge audience, lockout
   arithmetic, timing differences between "no such user" and "wrong password", anything
   that lets a token outlive a revocation.

3. Authorization. `packages/policy` and the guards in `apps/api/src/common`. Deny-by-default
   is claimed — find a route or a code path that reaches a handler without a permission
   check. Campus scoping is claimed to narrow a CAMPUS_ADMIN — find a way to widen it.

4. The purge path, `apps/worker` and `packages/module-kit/src/purge.ts`. It deletes data.
   Find an input or a state that makes it delete the wrong rows, delete a legally-held
   class, or mark a purge complete that did not finish.

5. The audit log, `packages/audit`. It claims to be append-only and free of secrets. Find a
   value that reaches it unredacted, or a path that rewrites or loses a line.

6. Everything else: injection, unbounded queries, unvalidated input reaching SQL or the
   filesystem, secrets in logs or error bodies, dependency vulnerabilities, denial of
   service through a missing limit.

HOW TO WORK
- Use current tooling and current knowledge: dependency and CVE scanning, static analysis,
  fuzzing where it fits, and whatever your own judgement suggests. Say which tools you ran.
- Read the tests as evidence of what the author was thinking, then look specifically for the
  case they did not think of. Several defects in this repository were found exactly there.
- A test passing does not mean a property holds. Check whether the test could fail: if a
  safety check is removed, does anything go red? If not, the property is untested.
- Prefer a working reproduction over an argument. Write the failing query, the request
  sequence, or the script.

WHAT TO SEND BACK

A report, in this shape, ordered by severity:

  ## Summary
  What you attacked, what tooling you used, and what you did not get to.

  ## Findings
  For each:
    ID              SEC-001, SEC-002, …
    Severity        critical | high | medium | low, and why that level
    Location        file and line, or the endpoint
    What is wrong   one paragraph, no hedging
    Reproduction    exact steps, query, or request sequence — the thing that makes it
                    undeniable
    Impact          what an attacker gets, in terms of this system's data
    Suggested fix   optional; Claude decides the fix, but say what you would do

  ## Things I checked that were sound
  Brief. This is not padding — it tells Claude where not to look again, and it is the only
  part of the report that is allowed to say something is fine.

RULES
- No fix commits, no pull requests, no branches. Findings only.
- A finding without a reproduction will be returned rather than argued with.
- Severity is your call, and you will be asked to defend it. Do not inflate to be heard, and
  do not soften a real one to seem reasonable.
- If you find nothing in an area, say what you tried. "Looks fine" is not a finding or a
  clearance.
```

---

## Running the suites

A reproduction is worth more than an argument, and most reproductions here need a database.

```bash
pnpm install
# PostgreSQL 16 on localhost:5432; see docs/local-development.md
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/church_test
pnpm -r test:integration
pnpm -r test:isolation     # the cross-tenant battery
pnpm run verify            # lint, format, typecheck, boundaries, contracts, doc links
```

Two traps that have already produced defects, worth knowing before writing a reproduction:

- **RLS does not apply to superusers, or to a table's owner unless the table is FORCE'd.**
  CI connects as `postgres`, which is both. A test written against that connection passes
  whether or not the policy works. `packages/testing` exposes `APP_ROLE` and `asTenant()`
  for this reason — a probe that does not drop to the non-superuser role proves nothing.
- **The database's collation is not ours to assume.** CI runs `en_US.UTF-8`; a developer
  machine may be `C`. An ordering that differs between them is not necessarily a bug, and
  an assertion that depends on it is.

## What happens to your report

Claude triages every finding, fixes what is real as a `REV-nnn` ticket carrying a
regression test that fails against the commit you reported, and replies in writing to
anything dismissed — with the reason the described sequence cannot happen, not merely that
it disagrees. Disagreement alone does not close a finding.
