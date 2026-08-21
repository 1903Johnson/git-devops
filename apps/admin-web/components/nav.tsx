// The navigation, as a stub.
//
// WEB-020 replaces the *source* of these items with `GET /me/modules`, which does not exist
// yet (CORE-025). The renderer below is shaped for that already: it takes a list and draws
// it, and knows nothing about where the list came from or which items are core. When the
// endpoint lands, `coreSections` is replaced by a fetch and nothing else here changes.
//
// Optional modules are deliberately absent rather than hardcoded and hidden. A nav that
// lists a module a church has not enabled teaches people to click things that 404, and the
// module system's whole point is that an absent module is absent — not greyed out.

import Link from 'next/link';

export interface NavItem {
  readonly label: string;
  readonly href: string;
}

/** Core is always present for every tenant (docs/01 §2). Modules are not, and wait. */
const coreSections: readonly NavItem[] = [
  { label: 'Dashboard', href: '/' },
  { label: 'People', href: '/people' },
  { label: 'Families', href: '/families' },
  { label: 'Campuses', href: '/campuses' },
];

export function Nav({ items = coreSections }: { items?: readonly NavItem[] }) {
  return (
    <nav aria-label="Main">
      <ul>
        {items.map((item) => (
          <li key={item.href}>
            <Link href={item.href}>{item.label}</Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
