import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Nav } from '../components/nav';

afterEach(cleanup);

describe('the navigation stub', () => {
  it('shows the core sections every tenant has', () => {
    render(<Nav />);
    for (const label of ['Dashboard', 'People', 'Families', 'Campuses']) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    }
  });

  it('renders whatever list it is given, which is how WEB-020 replaces the source', () => {
    // The renderer must not know where the items came from. When /me/modules lands
    // (CORE-025), only the caller changes.
    render(<Nav items={[{ label: 'Prayer wall', href: '/prayer-wall' }]} />);
    expect(screen.getByRole('link', { name: 'Prayer wall' })).toHaveAttribute(
      'href',
      '/prayer-wall',
    );
    expect(screen.queryByRole('link', { name: 'Dashboard' })).not.toBeInTheDocument();
  });
});
