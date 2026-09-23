export interface AuthConfig {
  issuer: string;
  backchannelUrl: string;
  jwksUri: string;
  clientId: string;
  redirectUri: string;
  apiUrl: string;
  redisUrl: string;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value.replace(/\/$/, '');
}

export function getAuthConfig(): AuthConfig {
  const issuer = required('KEYCLOAK_ISSUER');
  const backchannelUrl = required('KEYCLOAK_BACKCHANNEL_URL');
  return {
    issuer,
    backchannelUrl,
    jwksUri: (process.env.KEYCLOAK_JWKS_URI?.trim()
      || `${backchannelUrl}/protocol/openid-connect/certs`).replace(/\/$/, ''),
    clientId: required('KEYCLOAK_CLIENT_ID'),
    redirectUri: required('KEYCLOAK_REDIRECT_URI'),
    apiUrl: required('KEMFAI_API_URL'),
    redisUrl: required('REDIS_URL'),
  };
}
