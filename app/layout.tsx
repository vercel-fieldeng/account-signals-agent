import './globals.css';
import type { JSX, ReactNode } from 'react';
import type { Metadata, Viewport } from 'next';
import { GeistProvider, geistFontClasses } from '@vercel/geistcn/core';

export const metadata: Metadata = {
  title: 'Account Signals Slack Agent',
  description:
    'A focused eve hello-world agent connected to the Account Signals Slack channel.',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>): JSX.Element {
  return (
    <html className={geistFontClasses} lang="en" suppressHydrationWarning>
      <body>
        <GeistProvider>{children}</GeistProvider>
      </body>
    </html>
  );
}
