import { readFileSync } from 'fs';
import { resolve } from 'path';
import { INestApplication } from '@nestjs/common';
import { OpenAPIObject } from '@nestjs/swagger';
import { SwaggerModule } from '@nestjs/swagger';
import { load as loadYaml } from 'js-yaml';

/**
 * T022 — contract-first OpenAPI bootstrap. The live BFF does not "generate" its API spec
 * from decorators (two sources of truth would drift); it serves the committed contract
 * `specs/001-saas-onboarding-shell/contracts/openapi.yaml` verbatim, so a diff of the live
 * spec (GET /api-docs-json) against the committed file is zero by construction. Later
 * contract-test suites (T027+ and T108's CI wiring) rely on exactly that property.
 */

export const OPENAPI_CONTRACT_PATH_ENV = 'OPENAPI_CONTRACT_PATH';
export const API_DOCS_UI_PATH = 'api-docs';
export const API_DOCS_JSON_PATH = 'api-docs-json';

/**
 * Default: the committed contract at its repo-relative location. `__dirname` is
 * `<repo>/backend/api/<src|dist>/openapi`, so four levels up is the repository root in
 * every execution mode (ts-node, jest, `node dist/main.js`). Deployments whose layout
 * differs (e.g. the compose container mounts the contract at a fixed path) override via
 * OPENAPI_CONTRACT_PATH; relative override values resolve against the process cwd.
 */
export function committedOpenApiContractPath(): string {
  const override = process.env[OPENAPI_CONTRACT_PATH_ENV];
  if (override && override.trim()) {
    return resolve(process.cwd(), override);
  }
  return resolve(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'specs',
    '001-saas-onboarding-shell',
    'contracts',
    'openapi.yaml',
  );
}

function assertContractShape(doc: unknown, contractPath: string): asserts doc is OpenAPIObject {
  const fail = (reason: string): never => {
    throw new Error(`OpenAPI contract at ${contractPath} is not servable: ${reason}`);
  };
  if (typeof doc !== 'object' || doc === null) fail('parsed document is not an object');
  const candidate = doc as Record<string, unknown>;
  if (typeof candidate.openapi !== 'string' || !candidate.openapi.startsWith('3.')) {
    fail('missing/invalid "openapi" version string');
  }
  const info = candidate.info;
  if (
    typeof info !== 'object' ||
    info === null ||
    typeof (info as Record<string, unknown>).title !== 'string'
  ) {
    fail('missing "info.title"');
  }
  if (
    typeof candidate.paths !== 'object' ||
    candidate.paths === null ||
    Object.keys(candidate.paths).length === 0
  ) {
    fail('"paths" must be a non-empty object');
  }
  const schemes = (candidate.components as Record<string, unknown> | undefined)?.securitySchemes as
    Record<string, unknown> | undefined;
  const bearerAuth = schemes?.bearerAuth as Record<string, unknown> | undefined;
  if (!bearerAuth || bearerAuth.type !== 'http' || bearerAuth.scheme !== 'bearer') {
    fail('components.securitySchemes.bearerAuth (http/bearer) is required');
  }
}

/**
 * Reads and parses the committed contract. Env is consulted on every call (not cached at
 * module load) so tests can point the loader at fixture contracts without module-registry
 * gymnastics — the same convention bearer-auth.guard.ts uses for KEYCLOAK_* vars.
 */
export function loadCommittedOpenApiContract(): OpenAPIObject {
  const contractPath = committedOpenApiContractPath();
  let raw: string;
  try {
    raw = readFileSync(contractPath, 'utf8');
  } catch (error) {
    throw new Error(
      `OpenAPI contract not found at ${contractPath} (set ${OPENAPI_CONTRACT_PATH_ENV} if the ` +
        `committed contract lives elsewhere in this deployment); cause: ${(error as Error).message}`,
    );
  }
  let doc: unknown;
  try {
    doc = loadYaml(raw);
  } catch (error) {
    throw new Error(
      `OpenAPI contract at ${contractPath} is not valid YAML: ${(error as Error).message}`,
    );
  }
  assertContractShape(doc, contractPath);
  return doc;
}

/**
 * Serves swagger-ui at /api-docs and the exact committed document at /api-docs-json.
 * Called from main.ts and from the T022 integration suite — the same helper, so the
 * tested wiring and the booted wiring cannot diverge.
 */
export function setupOpenApi(app: INestApplication): OpenAPIObject {
  const document = loadCommittedOpenApiContract();
  SwaggerModule.setup(API_DOCS_UI_PATH, app, document, {
    jsonDocumentUrl: API_DOCS_JSON_PATH,
    swaggerOptions: { persistAuthorization: true },
  });
  return document;
}
