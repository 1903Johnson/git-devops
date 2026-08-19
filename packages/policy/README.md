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

   **The rule is opt-in, and that is its sharp edge.** It compares `resource.campusId`
   against the subject's, so a caller that passes no resource — or one without a campus —
   is not scoped at all, and nothing says so. That is not a hypothetical: it is how a
   campus admin came to be able to list every person in the church (REV-002). Two kinds of
   caller have to do the work themselves, because the engine cannot:

   - **Anything returning a set.** A listing has no single campus to compare, so the query
     must narrow itself. `campusScopeOf(subject)` returns the campus a subject is confined
     to, or `undefined` when their reach is church-wide; it is exported precisely so the
     filter and the rule cannot drift into disagreeing about who is confined.
   - **Anything creating a row, or moving one between campuses.** A new row has no id yet,
     and a move is a write to the destination as well as the source — the engine only ever
     sees the resource it is handed, so both campuses have to be checked explicitly.

   Not every entity can be scoped this way. `family` and `family_member` carry no
   `campus_id` at all, so a household cannot currently be confined to a campus; a family
   whose members span two sites has no single answer. That is a modelling decision nobody
   has made yet, not an oversight to patch quietly — see `docs/04`, REV-002.
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
