/**
 * Opaque cursors for list endpoints.
 *
 * Base64url of the sort key, not the raw id. Two reasons, and the second is the one that
 * matters: a raw id invites a client to construct one, and the moment anybody does, the
 * cursor format is a public API that cannot change without breaking them.
 *
 * Keyset, not offset. An offset shifts under a reader when rows are inserted between pages,
 * so an entry is skipped — invisibly, and exactly once, which makes it very hard to notice.
 */
export interface Cursor {
  readonly name: string;
  readonly id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(cursor: Cursor): string {
  // The separator is a newline rather than a space because a campus may legitimately be
  // called "North Campus" — splitting on a space would put half the name in the id.
  return Buffer.from(`${cursor.name}\n${cursor.id}`, 'utf8').toString('base64url');
}

/**
 * Returns undefined for anything malformed rather than throwing.
 *
 * A stale or mangled cursor means a client that has been away for a while, or a copied URL.
 * Starting them at the first page is the behaviour they want; a 500 is not.
 */
export function decodeCursor(raw: string | undefined): Cursor | undefined {
  if (!raw) return undefined;
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const separator = decoded.lastIndexOf('\n');
    if (separator < 0) return undefined;
    const id = decoded.slice(separator + 1);
    // The id half goes straight into a uuid comparison, so it is validated here rather than
    // trusted for having arrived base64-encoded. Encoding is not authentication.
    if (!UUID_RE.test(id)) return undefined;
    return { name: decoded.slice(0, separator), id };
  } catch {
    return undefined;
  }
}
