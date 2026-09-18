'use server';

import { cookies } from 'next/headers';

import { defaultLocale, isLocale, localeCookieName, type Locale } from './config';

export async function getUserLocale(): Promise<Locale> {
  const cookieStore = await cookies();
  const value = cookieStore.get(localeCookieName)?.value;

  return isLocale(value) ? value : defaultLocale;
}

export async function setUserLocale(locale: Locale): Promise<void> {
  const cookieStore = await cookies();

  cookieStore.set(localeCookieName, locale, {
    path: '/',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 365,
  });
}
