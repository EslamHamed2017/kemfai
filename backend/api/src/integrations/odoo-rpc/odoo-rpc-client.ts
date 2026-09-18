/**
 * The subset of Odoo's JSON-RPC 2.0 transport {@link OdooRpcService} depends on.
 * Keeping this as a narrow structural interface (rather than exposing `fetch` directly)
 * is what lets unit tests substitute a fake in-memory client with no live Odoo server,
 * mirroring how `MinioStorageService` (T025) is tested against a fake `MinioClientLike`.
 */
export interface OdooRpcClientLike {
  call(service: string, method: string, args: unknown[]): Promise<unknown>;
}

interface OdooJsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { message: string; data?: { message?: string } };
}

/**
 * Config is read from `process.env` on every call (mirrors minio-client.ts's
 * `resolveMinioConfig` pattern) so tests can point at a different endpoint without a
 * module reload. `KEMFAI_ODOO_URL` is the full base URL wired by
 * infra/docker/docker-compose.yml and infra/.env.example (`http://kemfai-odoo:8069`
 * inside the compose network); the localhost fallback only applies to a developer
 * running Odoo directly on the host outside Docker.
 */
export function resolveOdooConfig(): { baseUrl: string } {
  return { baseUrl: process.env.KEMFAI_ODOO_URL ?? 'http://localhost:8069' };
}

let nextRequestId = 1;

export function createOdooRpcClient(): OdooRpcClientLike {
  return {
    async call(service: string, method: string, args: unknown[]): Promise<unknown> {
      const { baseUrl } = resolveOdooConfig();
      const response = await fetch(`${baseUrl}/jsonrpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'call',
          params: { service, method, args },
          id: nextRequestId++,
        }),
      });
      if (!response.ok) {
        throw new Error(`Odoo JSON-RPC request failed with HTTP ${response.status}`);
      }
      const body = (await response.json()) as OdooJsonRpcResponse;
      if (body.error) {
        throw new Error(body.error.data?.message ?? body.error.message);
      }
      return body.result;
    },
  };
}
