# `@church/worker`

Scheduled jobs. One pass at a time, then exit.

```bash
pnpm --filter @church/worker run purge:plan   # what would happen
pnpm --filter @church/worker run purge:run    # do it
```

## Why there is no timer in here

A long-lived process with `setInterval` inside an autoscaled deployment means every replica
racing the same purge, and a process that has been up for three weeks silently stops running
the job the moment it wedges — with nothing to alert on, because the process is still alive.

Scheduling belongs to the platform: a Kubernetes CronJob, an ECS scheduled task, a cron
line. Those can be observed, alerted on when a run does not happen, and made to run once.
Wiring it up is deployment configuration and lands with INF-005.

The job is safe under concurrent execution regardless, because whatever schedules it will
eventually double-fire. Each module is taken under a transaction-scoped advisory lock.

## The purge

```
disabled ──(module's retentionAfterDisable)──▶ pending_purge ──(14 days)──▶ purged
```

Two passes, never one. Collapsing them would take away the second grace period a church is
owed, and an entry is written at each step so "we told you" is a record rather than a claim.

Every step is a refusal with a delete at the end. The job stops — for that module only, and
keeps going with the rest — when:

| Condition | Why it stops |
|---|---|
| Module was re-enabled during the grace period | The clock stopped; so does this |
| A module table has no `church_id` | There is no correct `WHERE` for it, and the incorrect one takes every church's rows |
| The manifest declares `legalHoldClasses` | That data must be archived first (docs/02 §3), and archival is not built. Deleting data someone is legally required to keep is not a failure this job gets to have |
| No manifest for the module in this deployment | Its tables may not exist; guessing which to drop is not a guess worth making |
| Circular foreign keys between module tables | The delete order is not resolvable, and guessing leaves the module half-purged |

Deletes run child-first via a topological sort of the module's own foreign keys. A count of
dependants looks equivalent and breaks on a chain — with `a -> b -> c`, `b` and `c` tie, and
half the time the delete fails partway through.

The audit entry records counts, table names and data classes. Never content: the point is to
prove what was destroyed and when, not to keep a copy of it. The entry commits in the same
transaction as the deletes and the status change, so a purge cannot happen unrecorded.

## A note on what the tests prove

Through the job, deletes run as the application role inside a tenant context, so RLS scopes
them **even if the `WHERE church_id` clause were missing** — every job-level test passes
without it. That is good defence in depth and bad test coverage: a purge run as the table
owner, which is how a maintenance script would run it, has no RLS and the clause is the only
protection left.

`scopes the delete itself, not only through RLS` calls `executePurge` on an owner connection
for exactly that reason. It is the one test in this suite that fails when the clause is
removed.
