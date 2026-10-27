import { writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startFakeKeycloak } from './fake-keycloak';

interface JsonRpcRequest {
  id?: number;
  params?: {
    service?: string;
    method?: string;
    args?: unknown[];
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function main(): Promise<void> {
  const output = process.env.T112_FIXTURE_OUTPUT;
  const tenantId = process.env.T112_TENANT_ID;
  const tenantDatabase = process.env.T112_TENANT_DATABASE;
  if (!output || !tenantId || !tenantDatabase) {
    throw new Error('T112 live fixture configuration is incomplete');
  }

  const customerIssuer = 'http://127.0.0.1/realms/t112-owned-customers';
  const audience = 'kemfai-api';
  const identity = await startFakeKeycloak({ issuer: customerIssuer, audience });
  const ownerToken = await identity.signAccessToken({
    sub: '11200000-0000-4000-8000-000000000001',
    roles: ['WorkspaceOwner'],
    tenantId,
    expiresIn: '2h',
  });

  const odoo = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/jsonrpc') {
      response.statusCode = 404;
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      let payload: JsonRpcRequest;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonRpcRequest;
      } catch {
        response.statusCode = 400;
        response.end();
        return;
      }
      const service = payload.params?.service;
      const method = payload.params?.method;
      const args = payload.params?.args ?? [];
      let result: unknown;
      let error: { message: string; data: { message: string } } | undefined;
      if (service === 'common' && method === 'login' && args[0] === tenantDatabase) {
        result = 7;
      } else if (service === 'object' && method === 'execute_kw' && args[0] === tenantDatabase) {
        const model = args[3];
        const modelMethod = args[4];
        if (model === 'kemfai.module.selection' && modelMethod === 'kemfai_get_selection') {
          result = ['module.accounting'];
        } else if (model === 'kemfai.onboarding.checklist' && modelMethod === 'kemfai_get_state') {
          result = {
            customerAdded: false,
            bankAdded: false,
            productAdded: false,
            firstInvoiceReady: false,
          };
        } else {
          error = {
            message: 'Unsupported synthetic Odoo operation',
            data: { message: 'Unsupported synthetic Odoo operation' },
          };
        }
      } else {
        error = {
          message: 'Invalid synthetic Odoo request',
          data: { message: 'Invalid synthetic Odoo request' },
        };
      }
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id ?? 1,
          ...(error ? { error } : { result }),
        }),
      );
    });
  });
  const odooPort = await listen(odoo);

  await writeFile(
    output,
    JSON.stringify({
      customerIssuer,
      audience,
      jwksUri: identity.jwksUri,
      ownerToken,
      odooUrl: `http://127.0.0.1:${odooPort}`,
    }),
    { mode: 0o600 },
  );

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await Promise.all([identity.close(), close(odoo)]);
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
  await new Promise(() => undefined);
}

void main();
