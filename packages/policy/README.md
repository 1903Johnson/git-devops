# @church/policy

The authorization decision: *who, which church, which role, which resource, which action*
(`docs/01` §2.5).

```ts
assertCan(subject, 'group:manage', { type: 'group', churchId, groupId });
```

## The engine is pure

It takes a subject, a permission, and a resource description, and returns a decision. No
database access, no ambient state. Facts it needs — which groups this user leads, which
campus a record belongs to — are supplied by the caller.

That is deliberate. A policy engine that queries is one you cannot test exhaustively or
reason about, and authorization is exactly the code where "probably right" is not a
standard. The cost is that call sites must load context first; the benefit is that every
rule is covered by a unit test that runs in milliseconds.

## Every decision explains itself

```ts
{ allowed: false, rule: 'campus_scope', detail: '<campus id>' }
```

Not decoration. The audit log (CORE-021) records *why* access was granted, and a bare
"denied" is unactionable when a pastor calls to say they cannot see something they should.

## The rules, in order

1. **Tenancy** — a resource in another church is denied before anything else is considered,
   so the denial reports the boundary rather than the role, and never reveals whether the
   permission exists. RLS is the backstop; this is the same boundary asserted a layer up
   where it can be reported.
2. **Self-access** — a member may read and edit their own person record without holding any
   broad permission. The most common authenticated request in the product.
3. **Role permission** — the role must actually carry it. Deny by default: every path that
   is not an explicit allow is a denial.
4. **Campus scoping** — a campus admin holds church-wide permissions but may only exercise
   them on their own campus. `campus_id` is a scoping filter, never an isolation boundary
   (`docs/01` §2.3), so **RLS will not catch this** — the engine is the only thing standing
   in the way. Holding any church-wide role lifts the restriction.
5. **Group leadership** — `group:manage` from `GROUP_LEADER` reaches only groups they
   actually lead. Staff and above hold it church-wide. This is the case `docs/01` §2.5
   calls out: the permission is real, its reach is not global.
6. **Restricted sensitivity** — a resource marked `restricted` needs a permission that names
   it (`pastoral_care:read_restricted`), never a broad one. A general read must not open a
   pastoral case someone deliberately marked sensitive.

## Roles live in code

The role→permission mapping is a reviewable diff, testable, and versioned with the release.
Per-church custom roles come later and layer on top: a church granting itself
`billing:manage` through a UI is a deliberate decision, not an accident of storage.

Three properties are asserted rather than left to the shape of the arrays: members can
never reach another person's record, giving, or audit data; permissions escalate
monotonically from member to church admin; and billing, audit, and module control belong to
church admins alone.

## Module permissions

Modules register theirs at boot from their manifest (`docs/02` §2). The registry is open
rather than a closed union, because a closed set would mean core knew every module's
permissions — precisely the dependency the module architecture forbids. Registration is not
authorization; it exists so a typo fails loudly at startup instead of silently denying every
request forever.

## Not here yet

`@RequiresPermission()` as a decorator arrives with `apps/api` (CORE-013's HTTP layer), since
a decorator needs a framework to attach to. `assertCan` is the framework-agnostic form and
is what the decorator will call.
