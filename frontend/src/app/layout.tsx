import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'KEMFAI',
  description: 'KEMFAI SaaS onboarding shell.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" dir="ltr">
      <body>{children}</body>
    </html>
  );
}
