# `@church/audit`

What happened, who did it, and what changed. Specification: [`docs/01`](../../docs/01-architecture.md) §3 step 7 and [`docs/02`](../../docs/02-module-system.md) §5.3.

## Two properties this table has and no other does

**The application cannot rewrite history.** The application role holds `SELECT` and
`INSERT` on `audit_entry` and nothing else. Not "we don't update it" as a convention — no
request this platform can serve has the privilege. That is the entire value of an audit
log: it is only evidence if the code under investigation could not have edited it.

A trigger refuses `UPDATE` outright, including from the table owner. Grants stop the
application; the trigger stops a migration, a console session, and anyone who has talked
their way into the owner role. There is deliberately **no** matching `DELETE` trigger —
deleting a church must still cascade, and retention pruning is a real obligation later.
Deletion is therefore possible for the operator and impossible for the product, which is
the line that matters.

**Entries are written in the transaction that does the work.**

```ts
await db.transaction(async (tx) => {
  const before = await load(tx, id);
  await update(tx, id, changes);
  await new AuditService(tx).record({
    action: 'person.updated',
    resourceType: 'person',
    resourceId: id,
    before,
    after: await load(tx, id),
  });
});
```

Passing `tx` is not a convenience. An entry written on its own connection can commit while
the work rolls back — a log that says a thing happened which did not — or be lost while the
work commits, which is worse. Sharing the transaction makes them atomic: both or neither.
There is a test that rolls back mid-write and asserts the line is gone.

`record` throws rather than silently skipping when there is no tenant context. A no-op
would mean actions vanishing from the log exactly when the context is wrong, which is when
the log matters most.

## Secrets never enter the log

Values under keys that look like credentials — `password_hash`, `refreshToken`,
`secret_iv`, `recovery_code`, `authorization` — are replaced with `[redacted]` before
storage, recursively, in both `before` and `after`. Matching is case-insensitive and covers
snake_case and camelCase, because the same value arrives as `password_hash` from a row and
`passwordHash` from a contract type.

Redacted rather than dropped, so a diff still shows *that* a credential changed — which is
what an investigation looks for — without recording what it became. An audit log holding
password hashes has turned the record of a breach into a second breach.

## Ordering

`seq` is a `bigserial` and the only thing ordering and pagination depend on. Timestamps
cannot do this job: `now()` is transaction-start time in Postgres, so every entry written
inside one transaction shares it exactly — and several usually are, because an entry is
written alongside the work. Ordering by timestamp put them in arbitrary order, and a
timestamp cursor either repeated them or skipped them. `occurred_at` uses
`clock_timestamp()` so a reader still sees the real moment.

Offset pagination is wrong here for the usual reason: the log grows at the head, so an
offset shifts under a reader between pages and an entry slips past unseen.

## What is recorded today

| Action | Written by |
|---|---|
| `module.enabled` / `module.disabled` | `ModulesService`, with before/after and the consent acknowledgement |
| `session.started` | `AuthController`, after a successful login or MFA completion |
| `session.all_ended` | `AuthController`, the lost-phone case |

**Failed logins are not audited yet, and should be.** Attributing "wrong password for
someone@example.org" to a church needs a cross-tenant lookup that the login path
deliberately keeps inside `@church/identity`, so it needs a change there. Repeated failures
against one account are what brute-force detection is built on, so this gap is worth
closing rather than living with.

Restricted-class reads (`sensitivity: 'restricted'`) are supported by the schema, the query
API and the index, and will be written by the modules that hold such data — medical notes,
pastoral records, giving — as those land.
