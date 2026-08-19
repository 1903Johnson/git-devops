import type {
  Family,
  FamilyMember,
  MembershipStatusChange,
  Milestone,
  Person,
} from '@church/contracts';

/** Rows as the database holds them. snake_case stops at this file. */
export interface PersonRow {
  id: string;
  church_id: string;
  campus_id: string | null;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  gender: string | null;
  date_of_birth: Date | string | null;
  email: string | null;
  phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string | null;
  photo_url: string | null;
  status: Person['status'];
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface FamilyRow {
  id: string;
  church_id: string;
  name: string;
  created_at: Date;
  updated_at: Date;
}

export interface FamilyMemberRow {
  id: string;
  family_id: string;
  person_id: string;
  relationship: FamilyMember['relationship'];
  created_at: Date;
}

export interface StatusChangeRow {
  id: string;
  person_id: string;
  status: Person['status'];
  changed_at: Date;
  changed_by: string | null;
  note: string | null;
}

export interface MilestoneRow {
  id: string;
  church_id: string;
  person_id: string;
  campus_id: string | null;
  type: Milestone['type'];
  occurred_on: Date | string;
  officiant: string | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * A `date` column, as a date.
 *
 * `node-postgres` hands back a `Date` for `date` columns, built by parsing the value in the
 * *server's* timezone. Calling `toISOString()` on it shifts a birthday west of UTC to the
 * previous day — which is the kind of bug that shows up as one child in a hundred being
 * offered the wrong class, months after anyone would connect it to this line.
 */
export function toDateOnly(value: Date | string | null): string | undefined {
  if (value === null) return undefined;
  if (typeof value === 'string') return value.slice(0, 10);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function toPerson(row: PersonRow): Person {
  const address = {
    ...(row.address_line1 ? { line1: row.address_line1 } : {}),
    ...(row.address_line2 ? { line2: row.address_line2 } : {}),
    ...(row.city ? { city: row.city } : {}),
    ...(row.region ? { region: row.region } : {}),
    ...(row.postal_code ? { postalCode: row.postal_code } : {}),
    ...(row.country ? { country: row.country } : {}),
  };
  const birthday = toDateOnly(row.date_of_birth);

  return {
    id: row.id,
    churchId: row.church_id,
    campusId: row.campus_id,
    firstName: row.first_name,
    lastName: row.last_name,
    ...(row.preferred_name ? { preferredName: row.preferred_name } : {}),
    ...(row.gender ? { gender: row.gender } : {}),
    ...(birthday ? { dateOfBirth: birthday } : {}),
    ...(row.email ? { email: row.email } : {}),
    ...(row.phone ? { phone: row.phone } : {}),
    // Omitted rather than sent empty: `address: {}` reads as "we hold an address and it is
    // blank", which is a different claim from "we hold none".
    ...(Object.keys(address).length > 0 ? { address } : {}),
    ...(row.photo_url ? { photoUrl: row.photo_url } : {}),
    status: row.status,
    archivedAt: row.archived_at ? row.archived_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export const toFamily = (row: FamilyRow, members?: FamilyMember[]): Family => ({
  id: row.id,
  churchId: row.church_id,
  name: row.name,
  ...(members ? { members } : {}),
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

export const toFamilyMember = (row: FamilyMemberRow, person?: Person): FamilyMember => ({
  id: row.id,
  familyId: row.family_id,
  personId: row.person_id,
  relationship: row.relationship,
  ...(person ? { person } : {}),
  createdAt: row.created_at.toISOString(),
});

export const toStatusChange = (row: StatusChangeRow): MembershipStatusChange => ({
  id: row.id,
  personId: row.person_id,
  status: row.status,
  changedAt: row.changed_at.toISOString(),
  changedBy: row.changed_by,
  ...(row.note ? { note: row.note } : {}),
});

export const toMilestone = (row: MilestoneRow): Milestone => ({
  id: row.id,
  churchId: row.church_id,
  personId: row.person_id,
  campusId: row.campus_id,
  type: row.type,
  occurredOn: toDateOnly(row.occurred_on) ?? '',
  ...(row.officiant ? { officiant: row.officiant } : {}),
  ...(row.notes ? { notes: row.notes } : {}),
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});
