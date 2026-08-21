import type { ReactNode } from 'react';
import { themeCss } from '@church/ui-tokens';
import '@church/ui/styles.css';

export const metadata = {
  title: { default: 'Church admin', template: '%s · Church admin' },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* The design tokens are generated rather than authored, so they are injected
            rather than shipped as a stylesheet — one source for web and native. */}
        <style dangerouslySetInnerHTML={{ __html: themeCss }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
