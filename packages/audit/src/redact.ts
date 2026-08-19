/**
 * Field names whose values never enter the audit log.
 *
 * Matched case-insensitively against the whole key and against snake_case and camelCase
 * alike, because the same value arrives as `password_hash` from a row and `passwordHash`
 * from a contract type, and a redaction list that only catches one of them catches none of
 * the ones that matter.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /password/i,
  /secret/i,
  /token/i,
  /_hash$|hash$/i,
  /^authorization$/i,
  /cookie/i,
  /private[_-]?key/i,
  /recovery[_-]?code/i,
  /ciphertext|_iv$|_tag$/i,
];

export const REDACTED = '[redacted]';

export const isSecretField = (key: string): boolean =>
  SECRET_PATTERNS.some((pattern) => pattern.test(key));

/**
 * Replaces secret-looking values, recursively, leaving structure intact.
 *
 * Redacts rather than drops so a diff still shows *that* a credential changed — which is
 * exactly the kind of thing an investigation needs to see — without recording what it
 * changed to. An audit log holding password hashes and TOTP secrets turns the record of a
 * breach into a second breach.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value instanceof Date) return value.toISOString();

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSecretField(key) ? REDACTED : redact(item, depth + 1);
  }
  return out;
}

/**
 * The fields that differ between two snapshots.
 *
 * Shallow on purpose: a nested object counts as one changed field. "settings changed" is
 * what an administrator reading a log wants, and a deep path list turns one edit into
 * forty lines of noise. The before/after payloads are there for anyone who needs detail.
 */
export function changedFields(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): string[] {
  if (!before || !after) return [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (!same(before[key], after[key])) changed.push(key);
  }
  return changed.sort();
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date || b instanceof Date) {
    return (
      String(a instanceof Date ? a.toISOString() : a) ===
      String(b instanceof Date ? b.toISOString() : b)
    );
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  // Key order is not a change; JSON.stringify alone would say it is.
  return stable(a) === stable(b);
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
}
