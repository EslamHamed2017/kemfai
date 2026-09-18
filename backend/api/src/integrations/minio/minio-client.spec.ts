import { resolveMinioConfig } from './minio-client';

const ENV_KEYS = ['STORAGE_ENDPOINT', 'STORAGE_ACCESS_KEY', 'STORAGE_SECRET_KEY'] as const;

/**
 * T025: `resolveMinioConfig` is the only place `STORAGE_ENDPOINT`/`STORAGE_ACCESS_KEY`/
 * `STORAGE_SECRET_KEY` are parsed, mirroring `resolveAuthConfig`'s env-per-call pattern
 * (bearer-auth.guard.ts) so tests never depend on a live MinIO server.
 */
describe('resolveMinioConfig (T025)', () => {
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) original[key] = process.env[key];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  it('falls back to the docker-compose dev defaults when no env vars are set', () => {
    for (const key of ENV_KEYS) delete process.env[key];

    expect(resolveMinioConfig()).toEqual({
      endPoint: 'localhost',
      port: 9000,
      useSSL: false,
      accessKey: 'kemfai_minio',
      secretKey: 'kemfai_dev_minio_secret',
    });
  });

  it('parses host/port/useSSL from STORAGE_ENDPOINT and reads credentials from env', () => {
    process.env.STORAGE_ENDPOINT = 'https://minio.internal:9443';
    process.env.STORAGE_ACCESS_KEY = 'svc-key';
    process.env.STORAGE_SECRET_KEY = 'svc-secret';

    expect(resolveMinioConfig()).toEqual({
      endPoint: 'minio.internal',
      port: 9443,
      useSSL: true,
      accessKey: 'svc-key',
      secretKey: 'svc-secret',
    });
  });

  it('defaults to port 443 for an https endpoint with no explicit port', () => {
    process.env.STORAGE_ENDPOINT = 'https://minio.internal';

    expect(resolveMinioConfig().port).toBe(443);
    expect(resolveMinioConfig().useSSL).toBe(true);
  });
});
