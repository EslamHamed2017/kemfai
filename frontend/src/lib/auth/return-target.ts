export const DEFAULT_POST_LOGIN_TARGET = '/mfa';
export const MFA_SETUP_RETURN_TARGET = '/mfa?setup=returned';

const ALLOWED_TARGETS = new Set([DEFAULT_POST_LOGIN_TARGET, MFA_SETUP_RETURN_TARGET]);

export function safePostLoginTarget(value: string | null | undefined): string {
  return value && ALLOWED_TARGETS.has(value) ? value : DEFAULT_POST_LOGIN_TARGET;
}
