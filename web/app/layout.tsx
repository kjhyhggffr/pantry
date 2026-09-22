import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'Pantry scanner',
  description: 'Barcode in, barcode out: a pantry sheet and a Frisco shopping queue.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
