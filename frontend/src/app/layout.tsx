import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';

import { defaultLocale, getDirection, isLocale } from '@/lib/i18n/config';
import '@carbon/styles/css/styles.css';
import './kemfai-app.css';

export const metadata: Metadata = {
  title: 'KEMFAI',
  description: 'KEMFAI SaaS onboarding shell.',
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const requestLocale = await getLocale();
  const locale = isLocale(requestLocale) ? requestLocale : defaultLocale;
  const messages = await getMessages();

  return (
    <html lang={locale} dir={getDirection(locale)}>
      <body>
        <NextIntlClientProvider locale={locale} messages={messages}>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
