# `@church/people`

People, families, membership history and milestones. The platform's central record
([`docs/01`](../../docs/01-architecture.md) §2.4.1).

## A Person is not a login

Children and visitors are Person records with no account at all. Nothing here may assume a
`User` exists for one, and no method takes a user id where it means a person. The link, when
there is one, is `app_user.person_id` — nullable, and usually null.

## Three rules the services enforce

**Status moves only through `changeStatus`.** `PersonUpdate` has no `status` field and the
service ignores one if it arrives. The history row and the denormalised `person.status` are
written in the same transaction, because two sources of truth that can disagree will.

**Archive, never delete.** Giving and attendance history reference people. A hard delete
would change last year's giving report because someone tidied the directory this year.
Archived people leave the directory and stay fetchable by id; erasure is a separate,
deliberate request under the data-privacy workflow.

**A family relationship is not an authorisation.** `parent` or `guardian` on a family member
says who is *related*, never who may collect a child at check-in — that is an explicit
`GuardianAuthorisation` owned by the children's check-in module ([`docs/02`](../../docs/02-module-system.md) §5).
A custody order routinely leaves a parent on this list and off that one, so nothing in this
package exposes a helper that could be mistaken for the other question.

## Households are many-to-many

A person belongs to more than one family after a remarriage, and an adult child appears in
both their parents' household and their own. Modelling it as a column on `person` would make
the platform pick one, which is a real pastoral problem rather than a data-modelling nicety.

`GET /families/{id}` embeds each member's person so a household renders in one call. The
*list* deliberately omits members: a directory of two hundred households would otherwise
carry every person in the church, several times over.

## Dates

`date_of_birth` and `occurred_on` are calendar dates, and are mapped as such. `node-postgres`
returns a `Date` for a `date` column, built by parsing the value in the *server's* timezone —
so `toISOString()` shifts a birthday west of UTC to the previous day. That surfaces as one
child in a hundred being offered the wrong class, months after anyone would connect it to a
mapping function. `toDateOnly` reads the local calendar fields instead, and there is a test
pinning it.

The same mapping runs for the embedded-person path, where `to_jsonb` hands back strings
rather than Dates. One function for both, so a birthday cannot mean two things.

## Listing

Keyset pagination over `(lower(last_name), id)`, shared with `@church/church`. Lower-cased
because ordering by `last_name` alone puts every lowercase surname after every uppercase one
— "de Souza" ends up on the last page of the directory.

Archived people are excluded unless explicitly asked for, and only the literal string `true`
asks: `?includeArchived=0` must not reveal people who have left, which truthiness on a query
string would.
